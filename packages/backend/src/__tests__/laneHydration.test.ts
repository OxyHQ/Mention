import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * The lane chip on the post DTO.
 *
 * A lane is a LENS: it changes nothing about distribution, visibility, replies or
 * federation, so everything worth guarding here is about the chip itself —
 * whether it appears, whether it is right, and whether a lane that cannot be
 * resolved costs the chip or the whole post.
 *
 * Against real rows. The suite this replaces mocked `Lane.find` and asserted the
 * filter object hydration built, which proved the helper produced the shape
 * somebody typed into the test and nothing about which lane came back — and a
 * query silently matching nothing looks exactly like the fail-soft path it is
 * supposed to be distinguished from.
 */

import { closePostgres, connectPostgres } from '../db/postgres';
import { clearPostScope, postScope, seedLane, seedPost } from './helpers/postFixtures';
import type { PostRecord } from '../db/posts/postRecord';
import type { CachedUserSummary } from '../services/userSummaryCache';

const scope = postScope('lane-hydration');
const AUTHOR_ID = scope.user('author');

const { getUserById, getUsersByIds } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
}));

vi.mock('../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById,
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map<string, CachedUserSummary>()),
  mset: vi.fn(async () => undefined),
}));

import { PostHydrationService } from '../services/PostHydrationService';

let service: PostHydrationService;

async function post(overrides: Record<string, unknown> = {}): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: AUTHOR_ID,
    authorship: [{ oxyUserId: AUTHOR_ID, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'hello', tag: 'en' }] },
    ...overrides,
  });
}

async function hydrate(record: PostRecord, maxDepth = 0) {
  return service.hydratePosts([record], { includeLinkMetadata: false, maxDepth });
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  getUserById.mockReset();
  getUsersByIds.mockReset();
  getUsersByIds.mockResolvedValue([
    { id: AUTHOR_ID, username: 'nate', name: { displayName: 'Nate' }, badges: [], verified: false },
  ]);
  service = new PostHydrationService();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('post hydration — the lane chip', () => {
  it('emits the lane summary on a post that carries one', async () => {
    const laneId = await seedLane(scope, { name: 'Notas de Nate', displayMode: 'tab' });
    const [hydrated] = await hydrate(await post({ laneId }));

    expect(hydrated?.lane).toEqual({
      id: laneId,
      name: 'Notas de Nate',
      // `displayMode` travels with the name because the chip's own menu needs it:
      // an owner can see, and change, whether that lane shows on their profile.
      displayMode: 'tab',
    });
  });

  it('omits the field entirely on a post with no lane', async () => {
    const [hydrated] = await hydrate(await post());

    expect(hydrated).toBeDefined();
    expect(hydrated?.lane).toBeUndefined();
    // The post itself hydrated, so the absence above is about the lane.
    expect(hydrated?.user?.id).toBe(AUTHOR_ID);
  });

  it('omits the chip when the lane row is gone rather than rendering a blank one', async () => {
    // A lane id that resolves to nothing. It cannot be WRITTEN that way —
    // `posts.lane_id` carries a foreign key, and its `ON DELETE SET NULL` means a
    // deleted lane takes the reference with it — so the record is mutated in
    // memory. That is the only shape in which this branch is reachable, which is
    // itself the stronger guarantee.
    const record = await post({ laneId: await seedLane(scope) });
    const [hydrated] = await hydrate({ ...record, laneId: 'lane-hydration-no-such-lane' });

    expect(hydrated).toBeDefined();
    expect(hydrated?.lane).toBeUndefined();
  });

  it('carries the chip for every post in the graph, deduped by lane', async () => {
    const laneId = await seedLane(scope, { name: 'Shared' });
    const first = await post({ laneId });
    const second = await post({ laneId });

    const hydrated = await service.hydratePosts([first, second], {
      includeLinkMetadata: false,
    });
    expect(hydrated.map((row) => row.lane?.name)).toEqual(['Shared', 'Shared']);
  });

  it('propagates to a QUOTED original for free — same object out of summaryMap', async () => {
    const laneId = await seedLane(scope, { name: 'Notas de Nate', displayMode: 'tab' });
    const quoted = await post({ laneId });
    const quoting = await post({ quoteOf: quoted.id });

    // `lane` is set in exactly ONE place — `buildPostSummary`'s return literal —
    // and nested references are the SAME summary objects, so a quoted post
    // carries its own lane with no per-reference code. That is a property of the
    // hydration graph, so a refactor could break it silently.
    const [hydrated] = await hydrate(quoting, 1);
    expect(hydrated?.quotedPost?.lane).toEqual({
      id: laneId,
      name: 'Notas de Nate',
      displayMode: 'tab',
    });
  });
});

/**
 * `lane_id` survives the READ, which is what "it is in the projection" means now.
 *
 * Mongo needed four projection strings kept in step, and the worst spelling of
 * that bug was forgetting the SLICER's: the chip present on a feed row and absent
 * on the SAME post as a thread parent, which reads as a caching problem. A
 * Postgres read selects the row, so that drift is gone; what remains worth
 * pinning is that the record layer maps the column at all. It did not, when the
 * columns first landed — `PostRecordInput` and `PostRecord` had no `laneId`, so
 * every write dropped it silently.
 */
describe('lane_id survives a write/read round trip', () => {
  it('comes back on the record the hydration path is handed', async () => {
    const laneId = await seedLane(scope);
    const written = await post({ laneId });
    expect(written.laneId).toBe(laneId);

    const { loadPostRecord } = await import('../db/posts/postRepository');
    const loaded = await loadPostRecord(written.id);
    expect(loaded?.laneId).toBe(laneId);
  });

  it('comes back as NULL, not undefined, for a post in no lane', async () => {
    // One state, not two. Mongo had to store the field ABSENT rather than null,
    // because `post_lane_chrono_v1`'s partial filter was `{ $exists: true }` and
    // a stored null satisfied it; the Postgres filter is `lane_id is not null`,
    // so null is exactly the state that stays out of the index.
    const written = await post();
    expect(written.laneId).toBeNull();
  });
});
