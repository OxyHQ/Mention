/**
 * The infra-heavier "related / discovery" SOURCE modules, against a real
 * database: `moreLikeThis`, `nearby` and `risingCreators`.
 *
 * The suite this replaces mocked `Post` and `AuthorFollowerSnapshot` and
 * asserted the KEYS of each match. Two of the three sources here cannot be
 * checked that way at all any more, and the third's most important case never
 * could be:
 *
 *  - **`moreLikeThis` carries a SEED-AUTHORIZATION gate, and it is the only
 *    security control in this file.** The RESULTS are always public and SFW, so
 *    a mocked test that watched `Post.find` not being called was asserting the
 *    implementation rather than the leak: what the gate protects is the SEED's
 *    own attributes. Pass a private post's id and the "related" set discloses
 *    its classification topics, its hashtags and its author. Each denial case
 *    below therefore stands up candidates that WOULD have matched, and asserts
 *    the answer is empty anyway — so the test fails if the gate is removed, not
 *    merely if it is refactored.
 *  - **`nearby` is PostGIS now, not `$near`.** `ST_MakePoint` takes
 *    `(longitude, latitude)` and a transposed pair is a plausible point in the
 *    wrong hemisphere — never an error. The fixtures are placed so that
 *    transposing them moves them roughly 6,000 km, and the radius cases are
 *    checked against real-world distances rather than against the query that
 *    produced them.
 *  - **`risingCreators` reads a real snapshot table.** Rate, not delta, is what
 *    ranks: an account going 5→50 must beat one going 100→110, which is the
 *    whole reason the denominator is smoothed. Asserted as an ORDER over rows,
 *    which is the thing a viewer actually sees.
 *
 * Coordinates are deliberately in the South Atlantic. Two sibling suites
 * (`db/postgis.test.ts`, `db/feedPredicates.test.ts`) place their fixtures in
 * Barcelona and Madrid, and the whole run shares ONE throwaway database — a
 * radius query that happened to cover their rows would be reading another
 * suite's writes. For the same reason corpus-wide reads are compared through
 * {@link suiteIdsOf} and fixtures are stamped fractionally in the future.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { FOLLOWER_SNAPSHOT_INTERVAL_MS } from '../services/followerSnapshotJob';
import { authorFollowerSnapshots, posts } from '../db/schema';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../db/posts/postRecord';
import {
  moreLikeThisSource,
  nearbySource,
  resetRisingCreatorsCache,
  risingCreatorsSource,
} from '../mtn/feed/engine/sources/relatedSources';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];
const snapshotOwners: string[] = [];

const VIEWER = 'relsrc-viewer';
const AUTHOR = 'relsrc-author';
const OTHER = 'relsrc-other';

/** See the module docblock — every fixture leads the corpus in `created_at`. */
const HORIZON = Date.now() + 60_000;

function at(offsetMs: number): Date {
  return new Date(HORIZON + offsetMs);
}

/**
 * Three points in the open South Atlantic, chosen so that (a) no sibling suite
 * writes anywhere near them and (b) BOTH coordinates are within ±90, so a
 * transposed pair is still a VALID point — roughly 6,000 km away in the North
 * Atlantic — rather than an out-of-range value the source would reject for a
 * different reason. `NEAR` sits ~85 km from `ORIGIN`; `FAR` sits ~1,110 km away,
 * beyond the clamped maximum radius.
 */
const ORIGIN = { latitude: -40, longitude: 25 };
const NEAR = { latitude: -40, longitude: 26 };
const FAR = { latitude: -30, longitude: 25 };

async function create(overrides: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  const owner = overrides.oxyUserId === undefined ? AUTHOR : overrides.oxyUserId;
  const record = await insertPostRecord({
    oxyUserId: owner,
    authorship: owner ? [{ oxyUserId: owner, role: 'owner', status: 'accepted' }] : [],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    createdAt: at(0),
    ...overrides,
  });
  created.push(record.id);
  return record;
}

/** A post at a capture location — what `posts.geo` is generated from. */
function createAt(
  point: { latitude: number; longitude: number },
  overrides: Partial<PostRecordInput> = {},
): Promise<PostRecord> {
  return create({
    location: { type: 'Point', coordinates: [point.longitude, point.latitude] },
    ...overrides,
  });
}

/** Every id a source returned, in order — for a read the predicate already scopes. */
function idsOf(records: readonly CandidatePost[]): string[] {
  return records.map((record) => record.id);
}

/** The ids THIS suite created, in order — for a read that sweeps the whole corpus. */
function suiteIdsOf(records: readonly CandidatePost[]): string[] {
  const mine = new Set(created);
  return records.map((record) => record.id).filter((id) => mine.has(id));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  // `risingCreators` memoizes its ranking for a full snapshot interval, so
  // without this every case after the first would rank the PREVIOUS case's
  // fixtures — the ranking outlives the rows it was computed from. Deleting the
  // snapshots below is not enough on its own, which is exactly the property the
  // cache exists to have.
  resetRisingCreatorsCache();
  const ids = created.splice(0);
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
  const owners = snapshotOwners.splice(0);
  if (owners.length > 0) {
    await db.delete(authorFollowerSnapshots).where(inArray(authorFollowerSnapshots.oxyUserId, owners));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the moreLikeThis source', () => {
  it('ranks candidates by how much of the seed they share, and excludes the seed', async () => {
    const seed = await create({
      createdAt: at(0),
      hashtags: ['relsrcmeow'],
      postClassification: { topics: ['relsrccats', 'relsrcpets'] },
    });
    // Two topics + one tag = 3. A DIFFERENT author, so the score is purely
    // content overlap and the three terms stay separable.
    const strong = await create({
      oxyUserId: OTHER,
      createdAt: at(-1_000),
      hashtags: ['relsrcmeow'],
      postClassification: { topics: ['relsrccats', 'relsrcpets'] },
    });
    // One topic = 1.
    const weak = await create({
      oxyUserId: OTHER,
      createdAt: at(-2_000),
      postClassification: { topics: ['relsrccats'] },
    });
    // Shares nothing but the author, which is itself worth 1.
    const sameAuthorOnly = await create({ oxyUserId: AUTHOR, createdAt: at(-3_000) });
    await create({ oxyUserId: OTHER, postClassification: { topics: ['relsrcsports'] } });
    // A boost has an intentionally empty body — never a "related post".
    await create({
      type: PostType.BOOST,
      boostOf: seed.id,
      content: { variants: [] },
      postClassification: { topics: ['relsrccats'] },
    });

    const ctx: FeedEngineContext = { currentUserId: VIEWER };
    const gathered = await moreLikeThisSource.gather(ctx, { postId: seed.id }, 30);

    expect(idsOf(gathered)).toEqual([strong.id, weak.id, sameAuthorOnly.id]);
    expect(gathered[0].finalScore).toBe(3);
    expect(gathered[1].finalScore).toBe(1);
    expect(gathered[2].finalScore).toBe(1);
    expect(idsOf(gathered)).not.toContain(seed.id);
  });

  it('takes a seed straight from params, lowercasing it, with nothing to exclude', async () => {
    const match = await create({
      createdAt: at(0),
      hashtags: ['relsrcjazz'],
      postClassification: { topics: ['relsrcmusic'] },
    });
    await create({ postClassification: { topics: ['relsrcsports'] } });

    // Mixed case in, canonical lowercase out — the stored slugs are lowercase.
    const gathered = await moreLikeThisSource.gather(
      {},
      { topics: ['RelsrcMusic'], hashtags: ['RelsrcJazz'] },
      30,
    );
    expect(idsOf(gathered)).toEqual([match.id]);
  });

  it('returns nothing when the seed carries no topics, hashtags or author', async () => {
    await create({ postClassification: { topics: ['relsrccats'] } });
    expect(await moreLikeThisSource.gather({}, {}, 30)).toEqual([]);
  });

  it('returns nothing for a seed id that names no post', async () => {
    // The Mongo original guarded this with `ObjectId.isValid`; that guard is
    // deleted, and a text id naming no row already produces the same answer.
    await create({ postClassification: { topics: ['relsrccats'] } });
    expect(await moreLikeThisSource.gather({}, { postId: 'relsrc-no-such-post' }, 30)).toEqual([]);
  });

  describe('the seed-authorization gate', () => {
    /**
     * Every case here stands up a candidate that WOULD match, so an empty answer
     * can only mean the gate fired. Without it, a viewer hands in a post id they
     * cannot read and infers its topics, its hashtags and its author from what
     * comes back — all of which is public content, which is exactly why the leak
     * is invisible in the response.
     */
    async function seedAndCandidate(
      visibility: PostVisibility,
      seedAuthor: string,
    ): Promise<{ seed: PostRecord; candidate: PostRecord }> {
      const seed = await create({
        oxyUserId: seedAuthor,
        visibility,
        createdAt: at(0),
        hashtags: ['relsrcmeow'],
        postClassification: { topics: ['relsrccats'] },
      });
      const candidate = await create({
        oxyUserId: OTHER,
        createdAt: at(-1_000),
        hashtags: ['relsrcmeow'],
        postClassification: { topics: ['relsrccats'] },
      });
      return { seed, candidate };
    }

    it('refuses a PRIVATE seed the viewer does not own', async () => {
      const { seed } = await seedAndCandidate(PostVisibility.PRIVATE, AUTHOR);
      const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [OTHER] };
      expect(await moreLikeThisSource.gather(ctx, { postId: seed.id }, 30)).toEqual([]);
    });

    it('refuses a FOLLOWERS_ONLY seed whose author the viewer does not follow', async () => {
      const { seed } = await seedAndCandidate(PostVisibility.FOLLOWERS_ONLY, AUTHOR);
      const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [OTHER] };
      expect(await moreLikeThisSource.gather(ctx, { postId: seed.id }, 30)).toEqual([]);
    });

    it('refuses any non-public seed to an anonymous viewer', async () => {
      const { seed } = await seedAndCandidate(PostVisibility.FOLLOWERS_ONLY, AUTHOR);
      expect(await moreLikeThisSource.gather({}, { postId: seed.id }, 30)).toEqual([]);
    });

    it('allows a FOLLOWERS_ONLY seed when the viewer follows its author', async () => {
      const { seed, candidate } = await seedAndCandidate(PostVisibility.FOLLOWERS_ONLY, AUTHOR);
      const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [AUTHOR] };
      expect(idsOf(await moreLikeThisSource.gather(ctx, { postId: seed.id }, 30))).toEqual([candidate.id]);
    });

    it('allows the viewer\'s OWN private seed', async () => {
      const { seed, candidate } = await seedAndCandidate(PostVisibility.PRIVATE, VIEWER);
      const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [] };
      expect(idsOf(await moreLikeThisSource.gather(ctx, { postId: seed.id }, 30))).toEqual([candidate.id]);
    });

    it('allows a PUBLIC seed regardless of follow state', async () => {
      const { seed, candidate } = await seedAndCandidate(PostVisibility.PUBLIC, AUTHOR);
      const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [] };
      // The seed is itself a candidate for the tag/topic match and must still be
      // excluded by id, which is the other half of this path.
      expect(idsOf(await moreLikeThisSource.gather(ctx, { postId: seed.id }, 30))).toEqual([candidate.id]);
    });
  });
});

describe('the nearby source', () => {
  it('bounds by radius and orders nearest-first', async () => {
    const origin = await createAt(ORIGIN, { createdAt: at(-2_000) });
    const near = await createAt(NEAR, { createdAt: at(0) });
    await createAt(FAR);
    await create();

    // The default radius is 50 km and `NEAR` is ~85 km out.
    const tight = await nearbySource.gather({}, { lat: ORIGIN.latitude, lng: ORIGIN.longitude }, 30);
    expect(suiteIdsOf(tight)).toEqual([origin.id]);

    // Widened past it, and ordered by DISTANCE — `near` is the more recent post,
    // so a chronological fallback would put it first.
    const wide = await nearbySource.gather(
      {},
      { lat: ORIGIN.latitude, lng: ORIGIN.longitude, radiusKm: 200 },
      30,
    );
    expect(suiteIdsOf(wide)).toEqual([origin.id, near.id]);
  });

  /**
   * The `(longitude, latitude)` argument order, asserted against a fact that is
   * knowable without re-running the query: transposing this suite's coordinates
   * moves them from 40°S 25°E to 25°N 40°W — the far side of the planet — so a
   * transposed WRITER or a transposed READER yields no rows here, while a
   * correctly-ordered pair yields the exact set above.
   */
  it('reads a transposed pair as a completely different place', async () => {
    await createAt(ORIGIN);
    await createAt(NEAR);

    const transposed = await nearbySource.gather(
      {},
      { lat: ORIGIN.longitude, lng: ORIGIN.latitude, radiusKm: 500 },
      30,
    );
    expect(suiteIdsOf(transposed)).toEqual([]);
  });

  it('clamps an oversized radius to the maximum instead of honouring it', async () => {
    const origin = await createAt(ORIGIN, { createdAt: at(0) });
    const near = await createAt(NEAR, { createdAt: at(-1_000) });
    // ~1,110 km out: inside 99999 km, outside the 500 km ceiling.
    await createAt(FAR);

    const gathered = await nearbySource.gather(
      {},
      { lat: ORIGIN.latitude, lng: ORIGIN.longitude, radiusKm: 99_999 },
      30,
    );
    expect(suiteIdsOf(gathered)).toEqual([origin.id, near.id]);
  });

  it('accepts numeric-string coordinates from the query string', async () => {
    const origin = await createAt(ORIGIN, { createdAt: at(0) });
    const near = await createAt(NEAR, { createdAt: at(-1_000) });

    const gathered = await nearbySource.gather(
      {},
      { lat: String(ORIGIN.latitude), lng: String(ORIGIN.longitude), radiusKm: '200' },
      30,
    );
    expect(suiteIdsOf(gathered)).toEqual([origin.id, near.id]);
  });

  it('excludes sensitive and boosted posts from the geo path', async () => {
    const clean = await createAt(ORIGIN, { createdAt: at(0) });
    const original = await create();
    await createAt(ORIGIN, { metadata: { isSensitive: true } });
    await createAt(ORIGIN, { hashtags: ['nsfw'] });
    await createAt(ORIGIN, { type: PostType.BOOST, boostOf: original.id, content: { variants: [] } });

    const gathered = await nearbySource.gather({}, { lat: ORIGIN.latitude, lng: ORIGIN.longitude }, 30);
    expect(suiteIdsOf(gathered)).toEqual([clean.id]);
  });

  it('falls back to the viewer region without coordinates, and for out-of-range ones', async () => {
    // Post coordinates are SPARSE, so the region match is what keeps the feed
    // non-empty for most viewers — it is a fallback, not an error path.
    const inRegion = await create({
      createdAt: at(0),
      postClassification: { region: 'relsrc-ES' },
    });
    await create({ postClassification: { region: 'relsrc-DE' } });
    await createAt(ORIGIN);

    const ctx: FeedEngineContext = { currentUserId: VIEWER, viewerRegion: 'relsrc-ES' };
    expect(suiteIdsOf(await nearbySource.gather(ctx, {}, 30))).toEqual([inRegion.id]);

    // A latitude of 999 is not a location; it must not be silently clamped into
    // one, and it must not throw either.
    expect(suiteIdsOf(await nearbySource.gather(ctx, { lat: 999, lng: 999 }, 30))).toEqual([inRegion.id]);
  });

  it('returns nothing with neither coordinates nor a viewer region', async () => {
    await createAt(ORIGIN);
    await create({ postClassification: { region: 'relsrc-ES' } });
    expect(await nearbySource.gather({}, {}, 30)).toEqual([]);
  });
});

describe('the risingCreators source', () => {
  /** Record a follower-count sample for `oxyUserId` at `at`. */
  async function snapshot(oxyUserId: string, followerCount: number, sampledAt: Date): Promise<void> {
    snapshotOwners.push(oxyUserId);
    await db.insert(authorFollowerSnapshots).values({ oxyUserId, followerCount, at: sampledAt });
  }

  const RISING_FAST = 'relsrc-rising-fast';
  const RISING_SLOW = 'relsrc-rising-slow';
  const SHRINKING = 'relsrc-shrinking';

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  it('ranks by growth RATE, so a small account outgrows a big one adding more', async () => {
    /**
     * `RISING_SLOW` gains 10 followers and `RISING_FAST` gains 45, but the point
     * is the rate: 45 / max(5, 10) = 4.5 against 10 / max(100, 10) = 0.1. Rank
     * by raw delta instead and the order flips — which is the whole reason the
     * denominator is smoothed rather than absent.
     */
    await snapshot(RISING_SLOW, 100, twoDaysAgo);
    await snapshot(RISING_SLOW, 110, dayAgo);
    await snapshot(RISING_FAST, 5, twoDaysAgo);
    await snapshot(RISING_FAST, 50, dayAgo);
    await snapshot(SHRINKING, 100, twoDaysAgo);
    await snapshot(SHRINKING, 90, dayAgo);

    const slowPost = await create({ oxyUserId: RISING_SLOW, createdAt: at(0) });
    const fastPost = await create({ oxyUserId: RISING_FAST, createdAt: at(-1_000) });
    await create({ oxyUserId: SHRINKING });
    // Not the author's own top-level public content.
    await create({ oxyUserId: RISING_FAST, visibility: PostVisibility.FOLLOWERS_ONLY });
    const root = await create({ oxyUserId: RISING_FAST, createdAt: at(-5_000) });
    await create({ oxyUserId: RISING_FAST, parentPostId: root.id });

    const gathered = await risingCreatorsSource.gather({}, {}, 30);
    // `root` is `RISING_FAST`'s too, and shares its score — the tie breaks on
    // recency, which is why it trails `fastPost`.
    expect(suiteIdsOf(gathered)).toEqual([fastPost.id, root.id, slowPost.id]);
    expect(gathered[0].finalScore).toBeCloseTo(4.5, 5);
    expect(gathered[gathered.length - 1].finalScore).toBeCloseTo(0.1, 5);
  });

  it('ignores samples older than the growth window', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await snapshot(RISING_FAST, 5, longAgo);
    await snapshot(RISING_FAST, 50, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    await create({ oxyUserId: RISING_FAST });

    expect(suiteIdsOf(await risingCreatorsSource.gather({}, {}, 30))).toEqual([]);
  });

  it('ignores an author whose follower count did not grow', async () => {
    await snapshot(SHRINKING, 100, twoDaysAgo);
    await snapshot(SHRINKING, 90, dayAgo);
    await snapshot('relsrc-flat', 50, twoDaysAgo);
    await snapshot('relsrc-flat', 50, dayAgo);
    await create({ oxyUserId: SHRINKING });
    await create({ oxyUserId: 'relsrc-flat' });

    expect(suiteIdsOf(await risingCreatorsSource.gather({}, {}, 30))).toEqual([]);
  });
});

/**
 * The RANKING is memoized for one snapshot interval; the posts query is not.
 *
 * The aggregation it removes has no `LIMIT` and cannot have one — every author's
 * first and last sample in the window is needed before any of them can be
 * ranked — so on a production-shaped corpus (2M snapshots, 12k authors, ~466k
 * rows in window) it sorted 466k rows for ~1.4s and 19MB of temp spill on EVERY
 * `gather`, uncached, at a user's refresh rate.
 *
 * Every case below is written so that it fails if the memo is removed AND if the
 * memo is wrong, which are different failures: the fixtures are DELETED between
 * calls, so a second `gather` that re-ran the aggregation would find nothing and
 * return `[]`. Each such assertion is paired with a reset-and-retry that proves
 * the deletion really happened — otherwise "still returns the same rows" would
 * pass just as well if the delete had silently matched nothing.
 */
describe('the risingCreators ranking cache', () => {
  async function snapshot(oxyUserId: string, followerCount: number, sampledAt: Date): Promise<void> {
    snapshotOwners.push(oxyUserId);
    await db.insert(authorFollowerSnapshots).values({ oxyUserId, followerCount, at: sampledAt });
  }

  const RISER = 'relsrc-cache-riser';
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  /** Seed one rising author with one post, and return that post's id. */
  async function seedRiser(): Promise<string> {
    await snapshot(RISER, 5, twoDaysAgo);
    await snapshot(RISER, 50, dayAgo);
    const post = await create({ oxyUserId: RISER, createdAt: at(0) });
    return post.id;
  }

  /** Remove every snapshot row this describe seeded. */
  async function deleteSnapshots(): Promise<void> {
    await db
      .delete(authorFollowerSnapshots)
      .where(inArray(authorFollowerSnapshots.oxyUserId, [RISER]));
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('issues ZERO aggregation queries on a second gather', async () => {
    const postId = await seedRiser();
    await risingCreatorsSource.gather({}, {}, 30);

    // Counted, not inferred: the aggregation is the only `select` whose
    // projection names `first` and `last`, so this distinguishes it from the
    // posts query and from everything `assemblePostRecords` reads.
    const select = vi.spyOn(db, 'select');
    const gathered = await risingCreatorsSource.gather({}, {}, 30);
    const aggregations = select.mock.calls.filter(([projection]) => {
      const keys = Object.keys((projection ?? {}) as Record<string, unknown>);
      return keys.includes('first') && keys.includes('last');
    });

    expect(aggregations).toHaveLength(0);
    // FLOOR: the spy really did observe this gather's queries, so the zero above
    // is an absence and not a spy that saw nothing at all.
    expect(select.mock.calls.length).toBeGreaterThan(0);
    expect(suiteIdsOf(gathered)).toEqual([postId]);
  });

  it('serves the same ranking from the memo after the snapshots are gone', async () => {
    const postId = await seedRiser();
    const first = await risingCreatorsSource.gather({}, {}, 30);
    expect(suiteIdsOf(first)).toEqual([postId]);

    await deleteSnapshots();

    const second = await risingCreatorsSource.gather({}, {}, 30);
    // Same authors, same order, same rates — a cache that changed the answer
    // would be a different feature.
    expect(suiteIdsOf(second)).toEqual([postId]);
    expect(second[0].finalScore).toBeCloseTo(first[0].finalScore ?? 0, 10);

    // POSITIVE CONTROL for the delete: without this, the assertion above would
    // pass identically if `deleteSnapshots` had matched nothing.
    resetRisingCreatorsCache();
    expect(suiteIdsOf(await risingCreatorsSource.gather({}, {}, 30))).toEqual([]);
  });

  it('reuses the ranking for exactly one snapshot interval, and no longer', async () => {
    const postId = await seedRiser();

    // Only `Date` is faked: the Postgres driver's own timers must keep running.
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);

    expect(suiteIdsOf(await risingCreatorsSource.gather({}, {}, 30))).toEqual([postId]);
    await deleteSnapshots();

    // One millisecond inside the interval: still the memo, and the rows behind
    // it no longer exist.
    vi.setSystemTime(start + FOLLOWER_SNAPSHOT_INTERVAL_MS - 1);
    expect(suiteIdsOf(await risingCreatorsSource.gather({}, {}, 30))).toEqual([postId]);

    // One millisecond past it: recomputed, and the recompute sees the deletion.
    // This is what ties the TTL to the SAMPLING CADENCE rather than to a number
    // chosen here — retune `FOLLOWER_SNAPSHOT_INTERVAL_MS` and this moves with
    // it, which is the property that keeps the two from drifting.
    vi.setSystemTime(start + FOLLOWER_SNAPSHOT_INTERVAL_MS + 1);
    expect(suiteIdsOf(await risingCreatorsSource.gather({}, {}, 30))).toEqual([]);
  });

  it('does NOT memoize a failure, which at this TTL would blank the source for hours', async () => {
    const postId = await seedRiser();

    // The aggregation is the first `select` a cold gather makes.
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('connection reset');
    });

    // Soft-fails, as it always did.
    expect(await risingCreatorsSource.gather({}, {}, 30)).toEqual([]);

    vi.restoreAllMocks();

    // And the very next gather tries again rather than serving the empty answer
    // for a full snapshot interval. `storyIndex` memoizes its empty answer on
    // purpose; at five minutes that is a retry bound, at six hours it would be
    // an outage.
    expect(suiteIdsOf(await risingCreatorsSource.gather({}, {}, 30))).toEqual([postId]);
  });

  it('runs ONE aggregation for concurrent cold gathers', async () => {
    const postId = await seedRiser();
    const select = vi.spyOn(db, 'select');

    const [a, b, c] = await Promise.all([
      risingCreatorsSource.gather({}, {}, 30),
      risingCreatorsSource.gather({}, {}, 30),
      risingCreatorsSource.gather({}, {}, 30),
    ]);

    const aggregations = select.mock.calls.filter(([projection]) => {
      const keys = Object.keys((projection ?? {}) as Record<string, unknown>);
      return keys.includes('first') && keys.includes('last');
    });

    // Without the shared in-flight promise this is 3 — the first request after
    // a restart is the worst case the cache exists to remove, multiplied by
    // however many arrive together.
    expect(aggregations).toHaveLength(1);
    expect(suiteIdsOf(a)).toEqual([postId]);
    expect(suiteIdsOf(b)).toEqual([postId]);
    expect(suiteIdsOf(c)).toEqual([postId]);
  });
});
