import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * The channel signature on the post DTO — and the anonymity it enforces.
 *
 * THREE failures this guards, in ascending order of consequence:
 *
 *  1. A dropped `channel_id` hydrates as `undefined` with NO error, so the
 *     signature appears on one code path and not another — which reads like a
 *     caching bug.
 *  2. `post.user` must stay the canonical Oxy `User` shape. Nothing may fabricate
 *     one from a channel: that would break `/@handle` links and poison the
 *     identity cache. The channel travels as its OWN field, and the renderer
 *     decides.
 *  3. With `signPosts: false` the writer must not travel AT ALL. Hiding them only
 *     in the UI is not anonymity when anyone can read the API response — so this
 *     is asserted on the DTO, and asserted to FAIL CLOSED when the channel row
 *     cannot be loaded.
 *
 * ## Real rows, and why that matters here more than anywhere
 *
 * The suite this replaces mocked `Channel.find` and asserted the FILTER OBJECT
 * hydration built. That could not distinguish a working lookup from one silently
 * matching nothing — and for (3) those two have opposite outcomes: a channel that
 * fails to load anonymizes, so a query matching nothing would have made every
 * anonymity assertion pass while the signature was simply broken. The channels
 * here are rows, so a lookup that stops working shows up as the SIGNATURE cases
 * going red rather than as the anonymity cases going quietly green.
 */

import { closePostgres, connectPostgres } from '../db/postgres';
import { clearPostScope, postScope, seedChannel, seedPost } from './helpers/postFixtures';
import type { PostRecord } from '../db/posts/postRecord';
import type { CachedUserSummary } from '../services/userSummaryCache';

const scope = postScope('channel-hydration');
const AUTHOR_ID = scope.user('author');
const BOOSTER_ID = scope.user('booster');

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

function makeOxyUser(id: string, username: string) {
  return { id, username, name: { displayName: username }, badges: [], verified: false };
}

let service: PostHydrationService;

/** Every string anywhere in the DTO — used to prove an id does NOT travel. */
function serialized(value: unknown): string {
  return JSON.stringify(value);
}

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
    makeOxyUser(AUTHOR_ID, 'writer'),
    makeOxyUser(BOOSTER_ID, 'booster'),
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

describe('post hydration — the channel signature', () => {
  it('emits the channel summary as its OWN field, never as post.user', async () => {
    const channelId = await seedChannel(scope, { handle: 'newsroom', title: 'The Newsroom' });
    const [hydrated] = await hydrate(await post({ channelId }));

    expect(hydrated?.channel).toMatchObject({
      id: channelId,
      handle: 'newsroom',
      title: 'The Newsroom',
      signPosts: false,
    });
    // `user` is still the canonical Oxy shape — the channel was NOT fabricated
    // into one. A `PostUser` built from a channel would break `/@handle` links.
    expect(hydrated?.user).not.toHaveProperty('handle');
  });

  it('omits the field entirely on a post with no channel', async () => {
    const [hydrated] = await hydrate(await post());

    expect(hydrated).toBeDefined();
    expect(hydrated?.channel).toBeUndefined();
    // And the author is intact, so the absence above is about the channel rather
    // than about hydration having failed.
    expect(hydrated?.user?.id).toBe(AUTHOR_ID);
  });

  it('carries the signature for every post in the graph, deduped by channel', async () => {
    const channelId = await seedChannel(scope, { handle: 'wire' });
    const first = await post({ channelId });
    const second = await post({ channelId });

    const hydrated = await service.hydratePosts([first, second], {
      includeLinkMetadata: false,
    });
    expect(hydrated.map((row) => row.channel?.handle)).toEqual(['wire', 'wire']);
  });

  it('propagates to a BOOSTED original — which is what makes "reposted by X" work', async () => {
    const channelId = await seedChannel(scope, { handle: 'newsroom' });
    const original = await post({ channelId });
    const boost = await seedPost(scope, {
      oxyUserId: BOOSTER_ID,
      authorship: [{ oxyUserId: BOOSTER_ID, role: 'owner', status: 'accepted' }],
      type: PostType.BOOST,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: {},
      boostOf: original.id,
    });

    // The boost is how a channel post reaches its writer's own profile, and the
    // row it paints is the ORIGINAL — signed by the channel — with "reposted by"
    // above it. That works only because the embedded original carries `channel`.
    const [hydrated] = await hydrate(boost, 1);
    expect(hydrated?.boost?.originalPost?.channel?.handle).toBe('newsroom');
  });
});

describe('post hydration — anonymity when signPosts is false', () => {
  it('strips the writer from the DTO entirely', async () => {
    const channelId = await seedChannel(scope, { handle: 'anon-desk', signPosts: false });
    const [hydrated] = await hydrate(await post({ channelId }));

    expect(hydrated?.channel?.signPosts).toBe(false);
    // Not merely a different display name: the author's id must not appear
    // ANYWHERE in the response. An opaque identifier is still an identifier.
    expect(serialized(hydrated)).not.toContain(AUTHOR_ID);
    expect(hydrated?.user?.username).toBe('');
    expect(hydrated?.authors).toEqual([]);
  });

  it('FAILS CLOSED: a channel the lookup did not return anonymizes rather than signs', async () => {
    // The condition is "has a channel and that channel is not in the map", NOT
    // "the channel says not to sign it" — so neither a missing row nor a failed
    // query can publish the writer. `buildChannelMap` catches its own errors into
    // an EMPTY map, so both arrive at this one branch, and this is the single
    // most consequential branch in the file.
    //
    // The post carries a channel id that resolves to nothing. It cannot be
    // WRITTEN that way — `posts.channel_id` has a foreign key, which is itself
    // the stronger guarantee — so the record handed to hydration is mutated in
    // memory after a real write. That is the only shape in which this branch is
    // reachable at all, and reaching it is the point.
    const channelId = await seedChannel(scope, { handle: 'newsroom', signPosts: true });
    const record = await post({ channelId });
    const orphaned = { ...record, channelId: 'channel-hydration-no-such-channel' };

    const [hydrated] = await hydrate(orphaned);

    expect(hydrated).toBeDefined();
    expect(hydrated?.channel).toBeUndefined();
    expect(serialized(hydrated)).not.toContain(AUTHOR_ID);
  });

  it('CONTROL: an ordinary post keeps its author', async () => {
    const [hydrated] = await hydrate(await post());

    expect(hydrated?.user?.id).toBe(AUTHOR_ID);
    expect(hydrated?.authors?.length).toBe(1);
  });

  it('CONTROL: signPosts true keeps the writer alongside the channel', async () => {
    const channelId = await seedChannel(scope, { handle: 'bylined', signPosts: true });
    const [hydrated] = await hydrate(await post({ channelId }));

    expect(hydrated?.channel?.signPosts).toBe(true);
    expect(hydrated?.user?.id).toBe(AUTHOR_ID);
    expect(hydrated?.authors?.length).toBe(1);
  });
});

/**
 * `channel_id` survives the READ, which is what "it is in the projection" means
 * now.
 *
 * Mongo needed four separate projection strings kept in step, and a field missing
 * from one of them hydrated as `undefined` with no error — worse for a channel
 * than for a chip, because the anonymity is keyed off the very field that went
 * missing. A Postgres read selects the row, so the four-way drift is gone; what
 * remains worth pinning is that the record layer maps the column at all. It did
 * not, when the columns first landed: `PostRecordInput` and `PostRecord` had no
 * `channelId`, so every write dropped it silently.
 */
describe('channel_id survives a write/read round trip', () => {
  it('comes back on the record the hydration path is handed', async () => {
    const channelId = await seedChannel(scope);
    const written = await post({ channelId });
    expect(written.channelId).toBe(channelId);

    const { loadPostRecord } = await import('../db/posts/postRepository');
    const loaded = await loadPostRecord(written.id);
    expect(loaded?.channelId).toBe(channelId);
  });

  it('comes back as NULL, not undefined, for a post with no channel', async () => {
    // One state, not two — which is why the exclusion in `authorFeedSql` can be
    // a flat `channel_id is null` with nothing else to check.
    const written = await post();
    expect(written.channelId).toBeNull();
  });
});
