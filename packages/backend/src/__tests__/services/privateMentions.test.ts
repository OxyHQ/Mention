/**
 * Private mentions (`direct` posts), end to end over real rows: who may read
 * one, how a reply's audience is decided, that no listing surfaces one, and the
 * conversations read. Oxy (identity, follows, content decisions) is the only
 * thing faked — everything Mention stores is real.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import { adultSafetyFixture } from '../helpers/adultSafety';

const { getUserFollowing, getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUserFollowing: vi.fn(async (_viewerId: string) => [] as unknown[]),
  getUsersByIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, name: { displayName: id }, badges: [] })),
  ),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    users: { get: vi.fn() },
    follows: { following: getUserFollowing, followers: vi.fn(async () => []) },
  }),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => undefined,
  createUserScopedOxyServices: () => undefined,
  getServiceOxyClient: () => ({
    safety: adultSafetyFixture(),
    users: { getMany: getUsersByIds },
    assets: { publicUrl: (id: string) => `https://cdn.test/${id}` },
  }),
}));
vi.mock('../../utils/privacyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/privacyHelpers')>()),
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
}));
vi.mock('../../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: () => ({ communityNotes: { shown: async () => [] } }),
}));
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { listPrivateMentionConversations } from '../../db/posts/postAudience';
import type { PostRecord } from '../../db/posts/postRecord';
import { mentionsOfMeSource } from '../../mtn/feed/engine/sources/socialSources';
import { PostHydrationService } from '../../services/PostHydrationService';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('private-mentions');
const AUTHOR = scope.user('author');
const RECIPIENT = scope.user('recipient');
const FOLLOWER = scope.user('follower');

describe('private mentions', () => {
  const service = new PostHydrationService();

  const sendDirect = () =>
    seedPost(scope, {
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
      visibility: PostVisibility.DIRECT,
      mentions: [RECIPIENT],
      content: { variants: [{ source: 'author', text: `hi [mention:${RECIPIENT}]`, tag: 'en' }] },
    });

  const reply = (parent: PostRecord, oxyUserId: string, visibility = PostVisibility.PUBLIC) =>
    seedPost(scope, {
      oxyUserId,
      authorship: [{ oxyUserId, role: 'owner', status: 'accepted' }],
      visibility,
      parentPostId: parent.id,
      threadId: parent.threadId ?? parent.id,
    });

  const readAs = (post: PostRecord, viewerId: string) =>
    service.hydratePosts([post], {
      viewerId,
      safetyRequester: { accessToken: `${viewerId}-session` },
      maxDepth: 0,
      includeLinkMetadata: false,
    });

  beforeAll(async () => {
    await connectPostgres();
  });
  beforeEach(() => {
    cacheStore.clear();
    // The follower follows the author; nobody else follows anyone.
    getUserFollowing.mockImplementation(async (viewerId: string) =>
      viewerId === FOLLOWER ? [{ id: AUTHOR }] : [],
    );
  });
  afterEach(async () => {
    await clearPostScope(scope);
  });
  afterAll(async () => {
    await closePostgres();
  });

  it('is readable by its recipient and author, never by a follower of its author', async () => {
    const dm = await sendDirect();
    expect(dm.recipients).toEqual([RECIPIENT]);

    const [asRecipient] = await readAs(dm, RECIPIENT);
    expect(asRecipient?.id).toBe(dm.id);
    expect(asRecipient?.metadata.recipients).toEqual([RECIPIENT]);
    expect(await readAs(dm, AUTHOR)).toHaveLength(1);
    expect(await readAs(dm, FOLLOWER)).toHaveLength(0);
  });

  it('narrows a reply to its parent: a conversation reply joins the conversation', async () => {
    const dm = await sendDirect();
    const answer = await reply(dm, RECIPIENT);
    expect(answer.visibility).toBe(PostVisibility.DIRECT);
    expect(answer.recipients).toEqual([AUTHOR]);

    const followersOnly = await seedPost(scope, {
      oxyUserId: AUTHOR,
      visibility: PostVisibility.FOLLOWERS_ONLY,
    });
    expect((await reply(followersOnly, FOLLOWER)).visibility).toBe(PostVisibility.FOLLOWERS_ONLY);

    // Somebody outside the conversation cannot write into it.
    await expect(reply(dm, FOLLOWER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('stays out of listings — the recipient’s mentions feed lists only the public mention', async () => {
    const dm = await sendDirect();
    const publicMention = await seedPost(scope, { oxyUserId: AUTHOR, mentions: [RECIPIENT] });

    const listed = (await mentionsOfMeSource.gather({ currentUserId: RECIPIENT }, {}, 50)).map(
      (post) => post.id,
    );
    expect(listed).toContain(publicMention.id);
    expect(listed).not.toContain(dm.id);
  });

  it('lists each conversation once, newest first, for its participants only', async () => {
    const dm = await sendDirect();
    const answer = await reply(dm, RECIPIENT);

    const conversations = await listPrivateMentionConversations(RECIPIENT, { limit: 10 });
    expect(conversations).toEqual([
      expect.objectContaining({ rootId: dm.id, latestPostId: answer.id, postCount: 2 }),
    ]);
    expect(await listPrivateMentionConversations(AUTHOR, { limit: 10 })).toHaveLength(1);
    expect(await listPrivateMentionConversations(FOLLOWER, { limit: 10 })).toEqual([]);
  });
});
