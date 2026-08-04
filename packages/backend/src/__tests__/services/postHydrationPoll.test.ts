/**
 * A poll created by the composer must come back on the post's DTO.
 *
 * This is the assertion the bug needed and did not have. The composer wrote the
 * poll to Mongo (`new Poll({...}).save()`) while `PostHydrationService` — the
 * single DTO producer for every post surface — reads polls from the Postgres
 * `polls` table. Both halves were individually correct and the write succeeded,
 * so nothing errored: the post simply carried a `pollId` that resolved to
 * nothing, and rendered as a post claiming a poll and showing none.
 *
 * `polls.controller.ts` inserts Postgres, which is the second create path and
 * why the feature was not universally broken — one way in worked, the other did
 * not.
 *
 * So the cases below go WRITE → READ through the real seams on both sides:
 * `createPollWithOptions` (what the composer now calls) and `hydratePosts`
 * (what every surface calls). Asserting that an insert happened would have
 * passed against the broken code, because an insert did happen — into the other
 * store.
 *
 * Oxy identity and the privacy helpers are mocked because they are network calls
 * to another service. The poll is real rows throughout.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';
import { inArray } from 'drizzle-orm';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getUserById, getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById,
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
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

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { attachPollToPost, createPollWithOptions } from '../../db/polls/pollRepository';
import { polls } from '../../db/schema/polls';
import { PostHydrationService } from '../../services/PostHydrationService';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('post-hydration-poll');
const AUTHOR = scope.user('author');

const service = new PostHydrationService();
const createdPollIds: string[] = [];

/** What the composer does, in the order it does it. */
async function composePostWithPoll(options: string[]) {
  const pollId = await createPollWithOptions({
    question: 'Which one?',
    options,
    createdBy: AUTHOR,
    endsAt: new Date(Date.now() + 60_000),
  });
  createdPollIds.push(pollId);
  const post = await seedPost(scope, {
    oxyUserId: AUTHOR,
    type: PostType.POLL,
    visibility: PostVisibility.PUBLIC,
    content: { variants: [{ source: 'author', text: 'a poll post', tag: 'en' }], pollId },
  });
  await attachPollToPost(pollId, post.id);
  return { pollId, post };
}

function hydratedPoll(hydrated: unknown): Record<string, unknown> | undefined {
  const content = (hydrated as { content?: { poll?: Record<string, unknown> } }).content;
  return content?.poll;
}

beforeAll(async () => {
  await connectPostgres();
  getUserById.mockResolvedValue(null);
  getUsersByIds.mockResolvedValue([]);
});

afterEach(async () => {
  if (createdPollIds.length > 0) {
    await getDb().delete(polls).where(inArray(polls.id, createdPollIds));
    createdPollIds.length = 0;
  }
  await clearPostScope(scope);
  cacheStore.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('a composed poll on the post DTO', () => {
  it('comes back on the hydrated post, with its options in the author order', async () => {
    const { post } = await composePostWithPoll(['Red', 'Green', 'Blue']);

    const [hydrated] = await service.hydratePosts([post], {
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });

    const poll = hydratedPoll(hydrated);
    expect(poll).toBeDefined();
    expect(poll?.question).toBe('Which one?');
    // Order is the assertion, not just membership: the options are separate rows
    // now and only `position` preserves the order the author typed them in.
    //
    // The wire shape is an array of plain STRINGS — the option rows carry ids,
    // but the DTO flattens them to labels and the client indexes `votes` by
    // POSITION, which is exactly why the order is load-bearing rather than
    // cosmetic.
    expect(poll?.options).toEqual(['Red', 'Green', 'Blue']);
    expect(poll?.votes).toEqual({ '0': 0, '1': 0, '2': 0 });
  });

  it('attaches the poll to the post it was composed with', async () => {
    const { pollId, post } = await composePostWithPoll(['Yes', 'No']);

    const [row] = await getDb()
      .select({ postId: polls.postId })
      .from(polls)
      .where(inArray(polls.id, [pollId]));

    expect(row?.postId).toBe(post.id);
  });

  it('refuses to move a poll that already belongs to a post', async () => {
    const { pollId, post } = await composePostWithPoll(['A', 'B']);
    const other = await seedPost(scope, { oxyUserId: AUTHOR });

    // `attachPollToPost` is scoped to `post_id is null`, so a second caller
    // naming someone else's poll id cannot steal it.
    expect(await attachPollToPost(pollId, other.id)).toBe(false);

    const [row] = await getDb()
      .select({ postId: polls.postId })
      .from(polls)
      .where(inArray(polls.id, [pollId]));
    expect(row?.postId).toBe(post.id);
  });
});
