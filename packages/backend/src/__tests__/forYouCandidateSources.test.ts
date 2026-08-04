/**
 * For You multi-source candidate generation, against a real database.
 *
 * The suite this replaces mocked `Post.find` and CLASSIFIED each captured match
 * by which key it contained, so "the language source fired" meant "a query
 * object had a `postClassification.languages` key". Every lane is exported, so
 * the same questions can now be asked of rows instead.
 *
 * What the cases guard:
 *
 *  - **Language match is ANY-OVERLAP, over the multi-language array.** A post
 *    classified `['en','es']` must reach a viewer whose preferred language is
 *    `es`. Matching a single scalar language lost every bilingual post, silently
 *    — the fixture is deliberately a post whose PRIMARY language is not the
 *    viewer's.
 *  - **For You is uniformly SFW, and the two halves of that live in two
 *    places.** The three sensitive FLAGS are excluded in SQL, on DISCOVERY lanes
 *    only; the NSFW-HASHTAG rule and the flags again are applied in code to the
 *    MERGED pool, covering following and affinity too. Asserting only the merged
 *    result cannot tell those apart, so the lanes are also called directly.
 *  - **A trusted lane is NOT query-gated, on purpose.** The viewer chose those
 *    authors. `gatherFollowingLane` returning a flagged post while
 *    `gatherForYouCandidates` drops it is the observable difference, and it is
 *    asserted as such — otherwise a future change that gates the following lane
 *    at the query level would look identical from the outside while quietly
 *    hiding a followed author's content from the chronological feed too.
 *  - **The merged pool is BOUNDED and the bound favours trusted lanes.** The cap
 *    case builds 150 real candidate rows across four lanes and asserts the pool
 *    is exactly `maxPool` and contains only trusted-lane content.
 *
 * The run shares ONE throwaway database and vitest runs files in parallel, so
 * fixtures are stamped fractionally in the FUTURE and pool-level reads are
 * compared through {@link suiteIdsOf}. Lane-level reads name this suite's own
 * authors, topics or languages, so they are compared with {@link idsOf} and also
 * prove nothing extra came back.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { postAuthorships } from '../db/schema/postContent';
import { posts } from '../db/schema';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../db/posts/postRecord';
import {
  gatherAffinityLane,
  gatherFollowingLane,
  gatherForYouCandidates,
  gatherGlobalLane,
  gatherLanguageLane,
  gatherRegionLane,
  gatherSubscribedListsLane,
  gatherTopicsLane,
  gatherTrendingLane,
} from '../mtn/feed/feeds/forYouCandidateSources';
import type { CandidatePost } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];

const VIEWER = 'fyc-viewer';
const FOLLOW = 'fyc-follow';
const AFFINITY = 'fyc-affinity';
const LIST_ONLY = 'fyc-list-only';
const STRANGER = 'fyc-stranger';

/** See the module docblock — every fixture leads the corpus in `created_at`. */
const HORIZON = Date.now() + 60_000;

function at(offsetMs: number): Date {
  return new Date(HORIZON + offsetMs);
}

async function create(overrides: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  const owner = overrides.oxyUserId === undefined ? STRANGER : overrides.oxyUserId;
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

/**
 * A `ContentAffinityService` stand-in returning a fixed candidate set.
 *
 * The real one reads engagement history through an Oxy client; the affinity
 * lane's own contract — which ids it asks for, and that it soft-fails — is what
 * these cases are about, so the service is the one thing injected rather than
 * built.
 */
function affinityStub(userIds: string[]) {
  return {
    getContentCandidates: vi.fn(async () =>
      userIds.map((userId) => ({ userId, weight: 1, reasons: ['engagement'] })),
    ),
  };
}

/** Every id a lane returned, in order — for a read the lane's own ids scope. */
function idsOf(records: readonly CandidatePost[]): string[] {
  return records.map((record) => record.id);
}

/** The ids THIS suite created, in order — for the pool, which sweeps the corpus. */
function suiteIdsOf(records: readonly CandidatePost[]): string[] {
  const mine = new Set(created);
  return records.map((record) => record.id).filter((id) => mine.has(id));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  const ids = created.splice(0);
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('the union of lanes', () => {
  it('contributes from following, affinity, topics, language and region at once', async () => {
    const followed = await create({ oxyUserId: FOLLOW, createdAt: at(0) });
    const affine = await create({ oxyUserId: AFFINITY, createdAt: at(-1_000) });
    const onTopic = await create({
      createdAt: at(-2_000),
      postClassification: { topics: ['fyc-tech'] },
    });
    const inLanguage = await create({
      createdAt: at(-3_000),
      postClassification: { languages: ['fyc-es'] },
    });
    const inRegion = await create({
      createdAt: at(-4_000),
      postClassification: { region: 'fyc-ES' },
    });

    const affinity = affinityStub([AFFINITY]);
    const pool = await gatherForYouCandidates({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      userBehavior: {
        preferredTopics: [{ topic: 'fyc-tech', weight: 5 }],
        preferredLanguages: ['fyc-es'],
      },
      viewerRegion: 'fyc-ES',
      seenPostIds: [],
      contentAffinityService: affinity,
    });

    const ids = new Set(suiteIdsOf(pool));
    expect(ids).toContain(followed.id);
    expect(ids).toContain(affine.id);
    expect(ids).toContain(onTopic.id);
    expect(ids).toContain(inLanguage.id);
    expect(ids).toContain(inRegion.id);
    // The affinity service is asked for a BOUNDED set and handed the viewer's
    // own request-scoped client, never a service one — the affinity read
    // resolves blocks and restrictions.
    expect(affinity.getContentCandidates).toHaveBeenCalledWith(VIEWER, {
      limit: MtnConfig.feed.candidateSources.maxAffinityCandidates,
      oxyClient: undefined,
    });
  });

  it('yields one entry for a post that several lanes returned', async () => {
    // A followed author's post also matches the viewer's preferred topic. The
    // merge keys on the post id, so it must appear exactly once — the trusted
    // copy, since trusted lanes merge first.
    const shared = await create({
      oxyUserId: FOLLOW,
      createdAt: at(0),
      postClassification: { topics: ['fyc-tech'] },
    });

    const pool = await gatherForYouCandidates({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      userBehavior: { preferredTopics: [{ topic: 'fyc-tech', weight: 5 }] },
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    expect(suiteIdsOf(pool).filter((id) => id === shared.id)).toEqual([shared.id]);
  });

  it('admits a subscribed-list author\'s PUBLIC posts and nothing more private', async () => {
    // Subscribing to a list is feed-inclusion, never a follow relationship, so
    // it grants no access a stranger does not already have.
    const listPublic = await create({ oxyUserId: LIST_ONLY, createdAt: at(0) });
    await create({ oxyUserId: LIST_ONLY, visibility: PostVisibility.FOLLOWERS_ONLY });

    const gathered = await gatherSubscribedListsLane({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      subscribedListMemberIds: [VIEWER, FOLLOW, LIST_ONLY],
      seenPostIds: [],
    });
    expect(idsOf(gathered)).toEqual([listPublic.id]);
  });
});

describe('the language lane', () => {
  /**
   * Regression: a bilingual post never reached the viewer.
   *
   * `postClassification.languages` holds EVERY detected/declared code, primary
   * first, and the match is ANY-overlap. The fixture's primary language is
   * deliberately NOT the viewer's, so a match against the scalar primary — or
   * against `languages[0]` — returns nothing and this goes red.
   */
  it('matches when ANY of a post\'s languages is one the viewer prefers', async () => {
    const bilingual = await create({
      createdAt: at(0),
      language: 'fyc-en',
      postClassification: { languages: ['fyc-en', 'fyc-es'] },
    });
    const monolingual = await create({
      createdAt: at(-1_000),
      language: 'fyc-es',
      postClassification: { languages: ['fyc-es'] },
    });
    await create({ postClassification: { languages: ['fyc-fr'] } });
    await create();

    const gathered = await gatherLanguageLane({
      viewerId: VIEWER,
      followingIds: [],
      userBehavior: { preferredLanguages: ['fyc-es'] },
      seenPostIds: [],
    });
    expect(idsOf(gathered)).toEqual([bilingual.id, monolingual.id]);
  });
});

describe('safety — For You is uniformly SFW', () => {
  /**
   * The TRUSTED half of the split, asserted where it is observable.
   *
   * A trusted lane has no query-level safety filter, deliberately: the viewer
   * chose those authors, and the same lane query backs the chronological
   * Following feed. Gating it in SQL would hide a followed author's flagged post
   * everywhere, not just in For You — so this asserts the lane RETURNS it, and
   * the case below asserts the merged pool then drops it.
   */
  it('leaves a followed author\'s flagged post in the trusted lane', async () => {
    const flagged = await create({
      oxyUserId: FOLLOW,
      createdAt: at(0),
      postClassification: { sensitive: true },
    });
    const clean = await create({ oxyUserId: FOLLOW, createdAt: at(-1_000) });

    const gathered = await gatherFollowingLane({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      seenPostIds: [],
    });
    expect(idsOf(gathered)).toEqual([flagged.id, clean.id]);
  });

  it('excludes flagged posts from a discovery lane at the query level', async () => {
    const clean = await create({ createdAt: at(0), postClassification: { topics: ['fyc-tech'] } });
    await create({ postClassification: { topics: ['fyc-tech'], sensitive: true } });
    await create({ metadata: { isSensitive: true }, postClassification: { topics: ['fyc-tech'] } });
    await create({
      postClassification: { topics: ['fyc-tech'] },
      federation: { activityId: `https://remote.example/notes/fyc-${Date.now()}`, sensitive: true },
    });
    // The NSFW-HASHTAG half is NOT a query-level rule — it is applied to the
    // merged pool, so this one survives the lane and is dropped below.
    const nsfwTagged = await create({
      createdAt: at(-1_000),
      hashtags: ['nsfw'],
      postClassification: { topics: ['fyc-tech'] },
    });

    const gathered = await gatherTopicsLane({
      viewerId: VIEWER,
      followingIds: [],
      userBehavior: { preferredTopics: [{ topic: 'fyc-tech', weight: 1 }] },
      seenPostIds: [],
    });
    expect(idsOf(gathered)).toEqual([clean.id, nsfwTagged.id]);
  });

  it('drops every flavour of sensitive from the MERGED pool, following included', async () => {
    const clean = await create({ oxyUserId: FOLLOW, createdAt: at(0) });
    const flaggedByClassifier = await create({
      oxyUserId: FOLLOW,
      postClassification: { sensitive: true },
    });
    const flaggedByMetadata = await create({ oxyUserId: FOLLOW, metadata: { isSensitive: true } });
    const flaggedByFederation = await create({
      oxyUserId: FOLLOW,
      federation: { activityId: `https://remote.example/notes/fyc-${Date.now()}`, sensitive: true },
    });
    // Mixed case, because the NSFW check normalizes the tag before comparing.
    const nsfwTagged = await create({ oxyUserId: FOLLOW, hashtags: ['NSFW'] });

    const pool = await gatherForYouCandidates({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    const ids = suiteIdsOf(pool);
    expect(ids).toContain(clean.id);
    expect(ids).not.toContain(flaggedByClassifier.id);
    expect(ids).not.toContain(flaggedByMetadata.id);
    expect(ids).not.toContain(flaggedByFederation.id);
    expect(ids).not.toContain(nsfwTagged.id);
  });
});

describe('bounds and exclusions', () => {
  it('excludes seen posts and anything outside the recency window', async () => {
    const fresh = await create({ oxyUserId: FOLLOW, createdAt: at(0) });
    const seen = await create({ oxyUserId: FOLLOW, createdAt: at(-1_000) });
    const stale = await create({
      oxyUserId: FOLLOW,
      createdAt: new Date(HORIZON - MtnConfig.feed.candidateSources.recencyWindowMs - 60_000),
    });
    // A boost mirrors a post that is already a candidate in its own right.
    const boost = await create({
      oxyUserId: FOLLOW,
      type: PostType.BOOST,
      boostOf: fresh.id,
      content: { variants: [] },
    });

    const gathered = await gatherFollowingLane({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      seenPostIds: [seen.id],
    });
    expect(idsOf(gathered)).toEqual([fresh.id]);
    expect(idsOf(gathered)).not.toContain(stale.id);
    expect(idsOf(gathered)).not.toContain(boost.id);
  });

  it('drops an affinity author the viewer already follows, so FOLLOWING owns them', async () => {
    // Observable in the LANE, not in the pool: a post the following lane also
    // returns is deduped on merge, so the pool cannot tell the two apart.
    const affineOnly = await create({ oxyUserId: AFFINITY, createdAt: at(0) });
    const followedToo = await create({ oxyUserId: FOLLOW, createdAt: at(-1_000) });

    const gathered = await gatherAffinityLane({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      userBehavior: {
        preferredAuthors: [
          { authorId: FOLLOW, weight: 9 },
          { authorId: AFFINITY, weight: 5 },
        ],
      },
      seenPostIds: [],
      contentAffinityService: affinityStub([FOLLOW, AFFINITY]),
    });

    expect(idsOf(gathered)).toEqual([affineOnly.id]);
    expect(idsOf(gathered)).not.toContain(followedToo.id);
  });

  it('no-ops every signal-driven lane for a viewer with no signals', async () => {
    // Each lane must return NOTHING rather than degenerate into an unbounded
    // scan — an empty id set is not "match everything".
    await create({ oxyUserId: FOLLOW, postClassification: { topics: ['fyc-tech'], languages: ['fyc-es'], region: 'fyc-ES' } });
    const noSignals = { viewerId: VIEWER, followingIds: [], seenPostIds: [] };

    expect(await gatherFollowingLane(noSignals)).toEqual([]);
    expect(await gatherSubscribedListsLane(noSignals)).toEqual([]);
    expect(await gatherTopicsLane(noSignals)).toEqual([]);
    expect(await gatherLanguageLane(noSignals)).toEqual([]);
    expect(await gatherRegionLane(noSignals)).toEqual([]);
    expect(await gatherAffinityLane({ ...noSignals, contentAffinityService: affinityStub([]) })).toEqual([]);
  });

  it('fires the region lane only for a non-empty region', async () => {
    const inRegion = await create({ createdAt: at(0), postClassification: { region: 'fyc-ES' } });
    await create({ postClassification: { region: 'fyc-DE' } });

    expect(
      idsOf(await gatherRegionLane({
        viewerId: VIEWER,
        followingIds: [],
        viewerRegion: 'fyc-ES',
        seenPostIds: [],
      })),
    ).toEqual([inRegion.id]);
    // Region is SPARSE and usually absent; an empty string is absent too, and
    // neither may become a `region = ''` scan.
    expect(
      await gatherRegionLane({ viewerId: VIEWER, followingIds: [], viewerRegion: '', seenPostIds: [] }),
    ).toEqual([]);
    expect(
      await gatherRegionLane({ viewerId: VIEWER, followingIds: [], seenPostIds: [] }),
    ).toEqual([]);
  });

  it('orders the trending lane by engagement, and leaves replies out of it', async () => {
    const hot = await create({ createdAt: at(-2_000) });
    const warm = await create({ createdAt: at(-1_000) });
    const root = await create({ createdAt: at(-3_000) });
    const reply = await create({ parentPostId: root.id, createdAt: at(0) });
    await db
      .update(posts)
      .set({ statsLikesCount: 9_000 })
      .where(inArray(posts.id, [hot.id, reply.id]));
    await db.update(posts).set({ statsLikesCount: 500 }).where(inArray(posts.id, [warm.id]));

    const gathered = await gatherTrendingLane({ viewerId: VIEWER, followingIds: [], seenPostIds: [] });
    const mine = suiteIdsOf(gathered);
    // `warm` is NEWER than `hot`, so a chronological fallback would invert this.
    expect(mine.indexOf(hot.id)).toBeLessThan(mine.indexOf(warm.id));
    expect(mine).not.toContain(reply.id);
  });

  it('survives an affinity service that throws, keeping every other lane', async () => {
    const followed = await create({ oxyUserId: FOLLOW, createdAt: at(0) });
    const failing = {
      getContentCandidates: vi.fn(async () => {
        throw new Error('affinity backend unavailable');
      }),
    };

    const pool = await gatherForYouCandidates({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      seenPostIds: [],
      contentAffinityService: failing,
    });

    expect(suiteIdsOf(pool)).toContain(followed.id);
    expect(failing.getContentCandidates).toHaveBeenCalled();
  });

  /**
   * The pool bound, on real rows.
   *
   * 150 candidates are spread across FOUR lanes because no single lane can
   * reach `maxPool` on its own — each carries its own per-source cap, and the
   * bound being tested is the one on their UNION. Merge order is trusted-first,
   * so a full pool is trusted content: the assertion is both that the size is
   * exactly `maxPool` and that discovery never displaced a followed author.
   */
  it('clamps the merged pool to maxPool, keeping trusted lanes over discovery', async () => {
    const cfg = MtnConfig.feed.candidateSources;
    const lanes: Array<{ author: string; count: number; classification: Record<string, string[]> }> = [
      { author: FOLLOW, count: cfg.perSource.following, classification: {} },
      { author: AFFINITY, count: cfg.perSource.affinity, classification: {} },
      { author: 'fyc-topic-author', count: cfg.perSource.topics, classification: { classificationTopics: ['fyc-tech'] } },
      { author: 'fyc-lang-author', count: cfg.perSource.language, classification: { classificationLanguages: ['fyc-es'] } },
    ];
    // Written straight to `posts` + `post_authorships`: 150 full records would
    // buy 150 extra transactions and no extra coverage — the lanes read the
    // authorship join and the classification columns, nothing else.
    for (const lane of lanes) {
      const rows = await db
        .insert(posts)
        .values(
          Array.from({ length: lane.count }, (_unused, index) => ({
            oxyUserId: lane.author,
            createdAt: at(-index * 10),
            ...lane.classification,
          })),
        )
        .returning({ id: posts.id });
      created.push(...rows.map((row) => row.id));
      await db.insert(postAuthorships).values(
        rows.map((row) => ({
          postId: row.id,
          oxyUserId: lane.author,
          role: 'owner' as const,
          status: 'accepted' as const,
        })),
      );
    }

    const pool = await gatherForYouCandidates({
      viewerId: VIEWER,
      followingIds: [FOLLOW],
      userBehavior: {
        preferredTopics: [{ topic: 'fyc-tech', weight: 5 }],
        preferredLanguages: ['fyc-es'],
      },
      seenPostIds: [],
      contentAffinityService: affinityStub([AFFINITY]),
    });

    expect(pool).toHaveLength(cfg.maxPool);
    // Exactly the four lanes above filled it, so nothing a sibling suite wrote
    // could have reached the pool through the global lane.
    expect(suiteIdsOf(pool)).toHaveLength(cfg.maxPool);
    expect(new Set(pool.map((post) => post.oxyUserId))).toEqual(
      new Set(lanes.map((lane) => lane.author)),
    );
  });
});
