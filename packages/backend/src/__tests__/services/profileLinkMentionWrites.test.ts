import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PASTED PROFILE LINK REACHES `post.mentions`, AND THAT IS THE POINT.
 *
 * `services/profileLinkMentions.test.ts` pins the fold itself. This pins the
 * CONSEQUENCE at the real write boundary: driven through `PostCreationService.create`,
 * a profile link the author pasted ends up in the post's stored `mentions`
 * allowlist and rings the mentioned person's notification — the same allowlist
 * that puts the post in their mentions feed.
 *
 * That is a deliberate behaviour change, not a side effect to be minimised. It
 * is what the inbound-federation ingest has always done with the identical URL,
 * and it is what pasting somebody's profile link means. Pinning it here means a
 * future change that quietly demotes the conversion to display-only fails a test
 * that says so by name, rather than silently un-notifying people.
 *
 * The federated case pins the other half: an ingested body is NOT folded again
 * here, because it already went through the same lookup against the same stored
 * identities on the way in.
 *
 * Harness copied from `services/postCreationEnrichment.test.ts` — the real
 * `create` writing REAL ROWS, with the stored-actor repository and the federation
 * `constants` stubbed so profile-link resolution is answerable without network or
 * Oxy I/O.
 *
 * The post is a real row on purpose. `create` writes through
 * `db/posts/postRepository` now, so the `new Post(...)` double this replaces
 * intercepted nothing — every case here would have died on an absent connection
 * rather than on the mention conversion it is about.
 */

const {
  getLinkPreviews,
  getUserById,
  createMentionNotifications,
  isBlockedDomain,
  resolveOxyUser,
  findActorByUri,
  findActorByAcct,
} = vi.hoisted(() => ({
  getLinkPreviews: vi.fn(),
  getUserById: vi.fn(),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findActorByUri: vi.fn(),
  findActorByAcct: vi.fn(),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications,
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/PostSubscription', () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: vi.fn().mockResolvedValue(undefined) }),
  registerPostCreator: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById,
    getUsersByIds: vi.fn().mockResolvedValue([]),
    getLinkPreviews,
  }),
}));

vi.mock('../../connectors/activitypub/constants', () => ({ isBlockedDomain, resolveOxyUser }));
vi.mock('../../db/federation/actorRepository', () => ({ findActorByUri, findActorByAcct }));

import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, serviceScope } from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';

const scope = serviceScope('profile-link-mention-writes');

const OWN_HOST = 'mention.earth';
const AUTHOR_ID = scope.user('local-author');
const ALICE_OXY_ID = scope.user('alice-local');
const BOB_OXY_ID = scope.user('bob-federated');

/** The primary author rendition of a post the service just built. */
function primaryText(post: unknown): string {
  const content = (post as { content?: { variants?: Array<{ text?: string }> } }).content;
  return content?.variants?.[0]?.text ?? '';
}

/** Let the detached (un-awaited) side-effect stages settle before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  getUserById.mockResolvedValue({ id: AUTHOR_ID, username: 'author' });
  getLinkPreviews.mockResolvedValue({});
  isBlockedDomain.mockImplementation(
    (host: string) => host.toLowerCase().replace(/^www\./, '') === OWN_HOST,
  );
  resolveOxyUser.mockImplementation(async (username: string) =>
    username === 'alice' ? { _id: ALICE_OXY_ID } : null,
  );
  findActorByUri.mockResolvedValue(null);
  findActorByAcct.mockResolvedValue(null);
});

describe('POST /posts — a pasted profile link becomes a real mention', () => {
  it('stores the id in `post.mentions` and rewrites the body to the placeholder', async () => {
    const post = await postCreationService.create({
      oxyUserId: AUTHOR_ID,
      content: { text: `have you met https://${OWN_HOST}/@alice yet` },
      visibility: PostVisibility.PUBLIC,
      skipSocketEmit: true,
    });

    expect(post.mentions).toEqual([ALICE_OXY_ID]);
    expect(primaryText(post)).toBe(`have you met [mention:${ALICE_OXY_ID}] yet`);
  });

  it('NOTIFIES the person named — the deliberate consequence of storing the mention', async () => {
    const post = await postCreationService.create({
      oxyUserId: AUTHOR_ID,
      content: { text: `have you met https://${OWN_HOST}/@alice yet` },
      visibility: PostVisibility.PUBLIC,
      skipSocketEmit: true,
    });
    await settle();

    expect(createMentionNotifications).toHaveBeenCalledWith(
      [ALICE_OXY_ID],
      post.id,
      AUTHOR_ID,
      'post',
    );
  });

  it('resolves a FOREIGN profile link through the actor rows we already store', async () => {
    findActorByAcct.mockResolvedValue({ oxyUserId: BOB_OXY_ID });

    const post = await postCreationService.create({
      oxyUserId: AUTHOR_ID,
      content: { text: 'as https://mastodon.social/@bob said' },
      visibility: PostVisibility.PUBLIC,
      skipSocketEmit: true,
    });

    expect(post.mentions).toEqual([BOB_OXY_ID]);
    expect(primaryText(post)).toBe(`as [mention:${BOB_OXY_ID}] said`);
  });

  it('keeps a link we cannot resolve as a link, and mentions nobody', async () => {
    const post = await postCreationService.create({
      oxyUserId: AUTHOR_ID,
      content: { text: 'as https://mastodon.social/@a-stranger said' },
      visibility: PostVisibility.PUBLIC,
      skipSocketEmit: true,
    });
    await settle();

    expect(post.mentions).toEqual([]);
    expect(primaryText(post)).toBe('as https://mastodon.social/@a-stranger said');
    expect(createMentionNotifications).not.toHaveBeenCalled();
  });

  it('keeps the mentions the composer picker sent alongside the pasted one', async () => {
    const post = await postCreationService.create({
      oxyUserId: AUTHOR_ID,
      content: { text: `[mention:oxy_picked] and https://${OWN_HOST}/@alice` },
      mentions: ['oxy_picked'],
      visibility: PostVisibility.PUBLIC,
      skipSocketEmit: true,
    });

    expect(post.mentions).toEqual(['oxy_picked', ALICE_OXY_ID]);
  });
});

describe('a FEDERATED ingest is not folded a second time', () => {
  /** The params an AP inbox `Create` / atproto import hands the shared route. */
  // `posts.federation_activity_id` carries a UNIQUE constraint — the import's own
  // dedupe — so one literal reused across cases makes the second create a
  // duplicate-key error rather than the fold-gate the case is about.
  let federatedSeq = 0;
  function federatedParams(text: string) {
    federatedSeq += 1;
    const activityId = `https://mastodon.social/users/alice/statuses/${scope.name}-${federatedSeq}`;
    return {
      oxyUserId: scope.user('remote-author'),
      federation: {
        activityId,
        actorUri: 'https://mastodon.social/users/alice',
        url: activityId,
        sensitive: false,
      },
      content: { variants: [{ source: 'author' as const, text }] },
      visibility: PostVisibility.PUBLIC,
      status: 'published' as const,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    };
  }

  it('spends no lookup and leaves the ingested body exactly as it arrived', async () => {
    // A body that the native fold WOULD convert, so the assertion distinguishes
    // "the gate held" from "there was nothing to convert".
    const post = await postCreationService.create(
      federatedParams(`greetings from https://${OWN_HOST}/@alice`),
    );

    expect(primaryText(post)).toBe(`greetings from https://${OWN_HOST}/@alice`);
    expect(post.mentions).toEqual([]);
    expect(resolveOxyUser).not.toHaveBeenCalled();
    expect(findActorByUri).not.toHaveBeenCalled();
    expect(findActorByAcct).not.toHaveBeenCalled();
  });

  it('still stores the mentions the ingest itself resolved', async () => {
    const post = await postCreationService.create({
      ...federatedParams(`hello [mention:${BOB_OXY_ID}]`),
      mentions: [BOB_OXY_ID],
    });

    expect(post.mentions).toEqual([BOB_OXY_ID]);
  });
});
