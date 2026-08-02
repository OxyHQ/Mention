import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * For You must rank thread ROOTS, not replies — enforced against a REAL database.
 *
 * ## What this guards
 *
 * A reply read outside its thread is close to meaningless ("thank you!", "same",
 * "@someone yes"), and on this instance replies are not a rounding error: measured
 * against production on 2026-08-01, the 7-day public published pool held 19,798
 * posts of which 9,330 were replies — 47.1% of the universe every For You lane
 * draws from. The constraint was applied by exactly ONE of the eight lanes
 * (trending), and the `popular` source — which IS the entire For You feed for a
 * signed-out reader, and the never-blank tail for a signed-in one — never applied
 * it at all.
 *
 * ## Why a real database rather than a mocked query
 *
 * The bug is a missing predicate, so a test that inspects the query object can
 * only assert that some expected shape is present — it re-states the fix rather
 * than checking its effect, and it passes just as happily if the predicate is
 * present but wrong. Executing the REAL queries against a REAL database over a
 * pool whose reply share is known removes that whole class of false pass: the
 * assertion is on the rows that come back.
 *
 * Every lane is exercised INDIVIDUALLY so a regression names the source that
 * leaked, and each lane's fixture pair is a reply and a root that both match that
 * lane's own predicate — so "no replies returned" can never be satisfied by a lane
 * that quietly matched nothing (the root assertion is the vacuity floor).
 *
 * Replies are seeded in BOTH encodings, because the local link and the federated
 * IRI diverge exactly where it matters: a federated reply whose parent never
 * resolved carries `federation.inReplyTo` with a null `parent_post_id`. Both are
 * folded into the STORED `is_reply` column by `derivesReplyIntent` at write time,
 * which is what lets every reader test one thing; seeding both encodings is what
 * proves the derivation, not just the readers. A third fixture carries
 * `federation.inReplyTo: ''` and must be treated as a ROOT, pinning the
 * empty-string sentinel — with a twist the port introduced, recorded below.
 *
 * ## The `''` sentinel is UNREPRESENTABLE here, and that is the stronger answer
 *
 * Mongo could store `federation.inReplyTo: ''` on a post whose `parentPostId`
 * was null, so "is the empty string a parent?" was a live question every reader
 * had to answer the same way. `posts_federated_reply_discriminator_check`
 * (`federation_in_reply_to is null or is_reply`) makes that row impossible to
 * write at all: `derivesReplyIntent` correctly reads `''` as "no parent", so
 * `is_reply` is false, and the CHECK then refuses the insert. The sentinel is
 * therefore pinned as a REFUSED WRITE rather than as a row in the pool — a
 * guarantee no reader can lose, instead of one every reader had to keep.
 */

const { closePostgres, connectPostgres, getDb } = await import('../db/postgres');
const { posts } = await import('../db/schema/posts');
const { insertPostRecord } = await import('../db/posts/postRepository');
const { PostType, PostVisibility } = await import('@mention/shared-types');
const { and, eq, inArray, sql } = await import('drizzle-orm');
const {
  gatherForYouCandidates,
  gatherFollowingLane,
  gatherSubscribedListsLane,
  gatherAffinityLane,
  gatherTopicsLane,
  gatherLanguageLane,
  gatherRegionLane,
  gatherTrendingLane,
  gatherGlobalLane,
} = await import('../mtn/feed/feeds/forYouCandidateSources');
const { popularSource, videosSource } = await import('../mtn/feed/engine/sources/discoverySources');
const { feedModuleRegistry } = await import('../mtn/feed/engine/FeedModuleRegistry');
const { registerSourceModules } = await import('../mtn/feed/engine/sources');
const { forYouDefinition, exploreDefinition, trendingDefinition } = await import(
  '../mtn/feed/definitions/presets'
);

type CandidatePost = Awaited<ReturnType<typeof gatherGlobalLane>>[number];
type GatherParams = Parameters<typeof gatherGlobalLane>[0];

const VIEWER = 'viewer';
const FOLLOWED_AUTHOR = 'follow-1';
const LIST_AUTHOR = 'list-1';
const AFFINITY_AUTHOR = 'aff-1';
const OTHER_AUTHOR = 'someone-else';

/** How a seeded post encodes (or does not encode) its parent. */
type ParentLink = 'root' | 'emptyIriRoot' | 'localReply' | 'federatedReply';

interface SeedSpec {
  /** Stable label used in assertions and failure messages. */
  label: string;
  author: string;
  link: ParentLink;
  /** Lane-selecting fields (topics / languages / region), and the video shape. */
  extra?: Record<string, unknown>;
  /**
   * Newest + most engaged, so this fixture survives a lane's `limit()` whatever
   * else is in the table. Set for the two lanes that select EVERY post
   * (trending, global): their per-source caps are 25 and 20, small enough that a
   * regression which floods the pool with replies could otherwise push their own
   * root past the cap and turn a leak into a confusing vacuity failure.
   */
  priority?: boolean;
}

/** Fixture timestamps: recent enough for every lane's recency window. */
const NOW = Date.now();

/** One lane under test: how to run it, and the pair of fixtures it must select. */
/** One lane under test: how to run it, and the pair of fixtures it must select. */
interface LaneCase {
  lane: string;
  run: (params: GatherParams) => Promise<CandidatePost[]>;
  /** Fields that make a post selectable by this lane. */
  selector: { author?: string; extra?: Record<string, unknown> };
}

const LANE_CASES: LaneCase[] = [
  { lane: 'following', run: gatherFollowingLane, selector: { author: FOLLOWED_AUTHOR } },
  { lane: 'subscribedLists', run: gatherSubscribedListsLane, selector: { author: LIST_AUTHOR } },
  { lane: 'affinity', run: gatherAffinityLane, selector: { author: AFFINITY_AUTHOR } },
  {
    lane: 'topics',
    run: gatherTopicsLane,
    selector: { extra: { postClassification: { topics: ['tech'] } } },
  },
  {
    lane: 'language',
    run: gatherLanguageLane,
    selector: { extra: { postClassification: { languages: ['es'] } } },
  },
  {
    lane: 'region',
    run: gatherRegionLane,
    selector: { extra: { postClassification: { region: 'ES' } } },
  },
  { lane: 'trending', run: gatherTrendingLane, selector: {} },
  { lane: 'global', run: gatherGlobalLane, selector: {} },
];

/** A video post as `FeedQueryBuilder.buildVideosQuery` requires it to look. */
const VIDEO_FIELDS: Record<string, unknown> = {
  type: 'video',
  content: {
    variants: [{ source: 'author', text: 'video' }],
    media: [{ type: 'video', durationSec: 60, width: 1080, height: 1920, orientation: 'portrait' }],
  },
};

/** Every fixture the collection is seeded with, one root + two replies per lane. */
const SEEDS: SeedSpec[] = [
  ...LANE_CASES.flatMap((laneCase): SeedSpec[] => {
    const author = laneCase.selector.author ?? OTHER_AUTHOR;
    const extra = laneCase.selector.extra;
    // A lane with no selector (trending, global) matches every seeded post, so
    // its own fixtures must outrank the rest to stay inside its cap.
    const priority = !laneCase.selector.author && !laneCase.selector.extra;
    return [
      { label: `${laneCase.lane}:root`, author, link: 'root', extra, priority },
      { label: `${laneCase.lane}:localReply`, author, link: 'localReply', extra, priority },
      { label: `${laneCase.lane}:federatedReply`, author, link: 'federatedReply', extra, priority },
    ];
  }),
  // Video pair, for the characterization test below. Shaped to satisfy
  // `buildVideosQuery`'s `content.media` $elemMatch (portrait, sized, long enough).
  { label: 'videos:root', author: OTHER_AUTHOR, link: 'root', extra: VIDEO_FIELDS },
  { label: 'videos:localReply', author: OTHER_AUTHOR, link: 'localReply', extra: VIDEO_FIELDS },
];

const params: GatherParams = {
  viewerId: VIEWER,
  followingIds: [FOLLOWED_AUTHOR],
  subscribedListMemberIds: [LIST_AUTHOR],
  userBehavior: {
    preferredTopics: [{ topic: 'tech', weight: 1 }],
    preferredLanguages: ['es'],
  },
  viewerRegion: 'ES',
  seenPostIds: [],
  contentAffinityService: {
    getContentCandidates: async () => [{ userId: AFFINITY_AUTHOR, weight: 1, reasons: ['engagement'] }],
  },
};

/**
 * The label a seeded post carries, keyed by the id the repository minted.
 *
 * The label cannot ride on the row itself: every lane assembles a whole
 * `PostRecord`, so an extra field would not survive, and assertions would compare
 * opaque uuids.
 */
const LABEL_BY_ID = new Map<string, string>();

/** The ids this suite created, so teardown removes exactly them. */
const createdIds: string[] = [];

/** The label a candidate was seeded with — what failure messages name. */
function labelOf(post: CandidatePost): string {
  return LABEL_BY_ID.get(post.id) ?? `unseeded:${post.id}`;
}

/**
 * A candidate is a reply if the STORED discriminator says so. That is the same
 * column every lane filters on, which is the point: `derivesReplyIntent` folds
 * both parent encodings into it once, at write time, so a reader that tests one
 * thing cannot miss the other.
 */
function replyLabels(candidates: CandidatePost[]): string[] {
  return candidates.filter((post) => post.isReply).map(labelOf);
}

/** A real parent row, so a local reply's `parent_post_id` satisfies its FK. */
let parentId = '';

async function seed(spec: SeedSpec): Promise<void> {
  const extra = (spec.extra ?? {}) as {
    postClassification?: Record<string, unknown>;
    content?: Record<string, unknown>;
    type?: string;
  };
  const record = await insertPostRecord({
    oxyUserId: spec.author,
    authorship: [{ oxyUserId: spec.author, role: 'owner', status: 'accepted' }],
    type: (extra.type as typeof PostType.TEXT) ?? PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    createdAt: new Date(spec.priority ? NOW : NOW - 60 * 60 * 1000),
    updatedAt: new Date(NOW),
    content: (extra.content as never) ?? { variants: [{ source: 'author', text: spec.label }] },
    ...(extra.postClassification ? { postClassification: extra.postClassification as never } : {}),
    ...parentFields(spec.link),
  });
  LABEL_BY_ID.set(record.id, spec.label);
  createdIds.push(record.id);

  // The engagement-sorted lanes (trending, popular) rank on these, and
  // `insertPostRecord` has no counter parameters — they are projections of real
  // rows everywhere else, so they are written directly here.
  await getDb()
    .update(posts)
    .set({
      statsLikesCount: spec.priority ? 100 : 5,
      statsBoostsCount: 1,
      statsCommentsCount: 2,
    })
    .where(eq(posts.id, record.id));
}

function parentFields(link: ParentLink): Record<string, unknown> {
  switch (link) {
    case 'root':
      return {};
    case 'emptyIriRoot':
      // Not a reply: the empty IRI is the "no parent" sentinel, not a parent —
      // which is why the schema refuses the row. See the sentinel test.
      return { federation: { inReplyTo: '' } };
    case 'localReply':
      return { parentPostId: parentId };
    case 'federatedReply':
      // The shape a bare `parent_post_id` check misses entirely.
      return { federation: { inReplyTo: 'https://remote.example/notes/9' } };
  }
}

beforeAll(async () => {
  await connectPostgres();
  // The parent every `localReply` points at. It is NOT one of the fixtures — it
  // carries no lane selector and is never expected in any lane's output — so it
  // is tracked for teardown but left out of `LABEL_BY_ID`, and a lane that
  // returned it would be reported as `unseeded:`.
  const parent = await insertPostRecord({
    oxyUserId: OTHER_AUTHOR,
    authorship: [{ oxyUserId: OTHER_AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PRIVATE,
    status: 'draft',
    content: { variants: [{ source: 'author', text: 'the parent' }] },
  });
  parentId = parent.id;
  createdIds.push(parent.id);

  for (const spec of SEEDS) await seed(spec);
}, 120_000);

afterAll(async () => {
  if (createdIds.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, createdIds));
  }
  await closePostgres();
});

describe('For You candidate pool — the fixture universe', () => {
  it('holds a substantial reply share, so the exclusion tests are not vacuous', async () => {
    /**
     * Counted over THIS suite's own ids: vitest runs files in parallel against
     * one database, so a bare "every public published post" count is a claim
     * about every other file in the run.
     *
     * The two seeded reply ENCODINGS are checked separately, because the whole
     * fixture design rests on `derivesReplyIntent` folding both into `is_reply`.
     * If it stopped recognising the federated one, the total below would still
     * look healthy while half the pool quietly stopped being replies — and every
     * exclusion assertion would pass for the wrong reason.
     */
    const seededIds = [...LABEL_BY_ID.keys()];
    const rows = await getDb()
      .select({ id: posts.id, isReply: posts.isReply })
      .from(posts)
      .where(and(
        inArray(posts.id, seededIds),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ));

    const expectedReplies = SEEDS.filter((spec) => spec.link === 'localReply' || spec.link === 'federatedReply');
    const replies = rows.filter((row) => row.isReply);

    expect(rows).toHaveLength(SEEDS.length);
    expect(replies).toHaveLength(expectedReplies.length);
    // Both encodings really were stored as replies, not just the local one.
    const replyLabelSet = new Set(replies.map((row) => LABEL_BY_ID.get(row.id)));
    expect([...replyLabelSet].filter((label) => label?.endsWith(':federatedReply')).length)
      .toBe(expectedReplies.filter((spec) => spec.link === 'federatedReply').length);
    // Mirrors the production shape this fix targets (47.1% replies).
    expect(replies.length / rows.length).toBeGreaterThan(0.4);
  });

  /**
   * The empty-IRI sentinel, as a refused write.
   *
   * `derivesReplyIntent` reads `''` as "no parent" — which is the behaviour this
   * pins — so `is_reply` comes out false, and
   * `posts_federated_reply_discriminator_check` then refuses the row: a stored
   * `federation_in_reply_to` may only exist on a post the discriminator agrees
   * is a reply. So the state every Mongo reader had to interpret consistently
   * cannot arise here at all.
   *
   * Mutation: make `derivesReplyIntent` treat a non-null `inReplyTo` as a reply
   * regardless of length and this insert SUCCEEDS, which is the failure.
   */
  it('refuses to store an empty inReplyTo, so no reader has to interpret it', async () => {
    await expect(
      insertPostRecord({
        oxyUserId: OTHER_AUTHOR,
        authorship: [{ oxyUserId: OTHER_AUTHOR, role: 'owner', status: 'accepted' }],
        type: PostType.TEXT,
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        content: { variants: [{ source: 'author', text: 'empty iri' }] },
        federation: { inReplyTo: '' },
      }),
      // The constraint name is on the CAUSE, not on drizzle's wrapper message.
    ).rejects.toSatisfy((error: unknown) =>
      JSON.stringify(error instanceof Error ? (error.cause ?? error) : error)
        .includes('posts_federated_reply_discriminator_check'),
    );
  });
});

describe('For You candidate lanes — every lane excludes replies', () => {
  // Vacuity floor on the table itself: the eight lanes of `gatherForYouCandidates`.
  it('covers all eight For You lanes', () => {
    expect(LANE_CASES).toHaveLength(8);
  });

  for (const laneCase of LANE_CASES) {
    it(`lane "${laneCase.lane}" returns its root and no replies`, async () => {
      const posts = await laneCase.run(params);

      // Vacuity floor: the lane really queried and really matched. Without this a
      // lane that silently returned [] would read as "excludes replies".
      const labels = posts.map(labelOf);
      expect(labels).toContain(`${laneCase.lane}:root`);

      expect(replyLabels(posts)).toEqual([]);
    });
  }
});

describe('gatherForYouCandidates — the merged pool', () => {
  it('drops every reply while keeping every lane\'s root', async () => {
    const pool = await gatherForYouCandidates(params);
    const labels = pool.map(labelOf);

    // Vacuity floor: all eight lanes contributed, plus the sentinel.
    for (const laneCase of LANE_CASES) {
      expect(labels).toContain(`${laneCase.lane}:root`);
    }
    // The measurement this change exists for. The seeded universe is two thirds
    // replies (above the 47.1% measured in production); the ranked pool that
    // comes out of it is 0%.
    expect(replyLabels(pool)).toEqual([]);
    expect(pool.length).toBe(SEEDS.filter((spec) => spec.link === 'root').length);
  });
});

describe('popular source — anonymous For You + never-blank fallback', () => {
  it('serves roots only', async () => {
    const posts = await popularSource.gather({}, {}, 50);

    // Vacuity floor: the source returned real candidates from the seeded pool.
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.map(labelOf)).toContain('trending:root');

    expect(replyLabels(posts)).toEqual([]);
  });

  it('keeps serving roots only for an authenticated fallback viewer', async () => {
    const posts = await popularSource.gather(
      { currentUserId: VIEWER, followingIds: [FOLLOWED_AUTHOR], seenPostIds: [] },
      {},
      50,
    );

    expect(posts.length).toBeGreaterThan(0);
    expect(replyLabels(posts)).toEqual([]);
  });
});

/**
 * The rule stated at the PRESET level, where a reader actually experiences it.
 *
 * Asserting a source excludes replies is not the same as asserting the FEED a
 * reader opens excludes them — the preset picks which source it runs, and that
 * choice is a second place the rule can be lost without touching any query. It
 * has been lost there in production: `descriptor=trending` measured 11 of 25
 * locally-linked replies on 2026-08-01 not because the `trending` LANE lacked a
 * filter (that lane was the one place the constraint already existed) but because
 * `trendingDefinition` runs `popular`, an entirely different source that had none.
 * Reading the wiring is how that is missed; running it is not.
 *
 * These three resolve their sources THROUGH the registry, exactly as
 * `FeedEngine.run` does, so repointing a preset at an unfiltered source fails
 * here even though every source keeps its own behaviour.
 */
describe('roots-only feed presets — resolved through the module registry', () => {
  const ROOTS_ONLY_PRESETS = [forYouDefinition, exploreDefinition, trendingDefinition];

  /** An authenticated viewer with every signal the For You lanes read. */
  const viewerCtx = {
    currentUserId: VIEWER,
    followingIds: [FOLLOWED_AUTHOR],
    subscribedListMemberIds: [LIST_AUTHOR],
    userBehavior: {
      preferredAuthors: [{ authorId: AFFINITY_AUTHOR, weight: 5 }],
      preferredTopics: [{ topic: 'tech', weight: 1 }],
      preferredLanguages: ['es'],
    },
    viewerRegion: 'ES',
    seenPostIds: [],
  };

  beforeAll(() => {
    registerSourceModules();
  });

  it('names presets that exist and are ranked discovery surfaces', () => {
    expect(ROOTS_ONLY_PRESETS.map((d) => d.id)).toEqual(['for_you', 'explore', 'trending']);
  });

  for (const definition of ROOTS_ONLY_PRESETS) {
    it(`preset "${definition.id}" gathers no replies from any of its sources`, async () => {
      const enabledSources = definition.sources.filter((ref) => ref.enabled);
      // Vacuity floor: the preset declares sources and every one resolves. A
      // preset whose ids stopped resolving would otherwise gather nothing and
      // read as compliant.
      expect(enabledSources.length).toBeGreaterThan(0);

      let gathered = 0;
      for (const ref of enabledSources) {
        const module = feedModuleRegistry.getSource(ref.module);
        if (!module) {
          throw new Error(`preset "${definition.id}" names unregistered source "${ref.module}"`);
        }

        const posts = await module.gather(viewerCtx, ref.params ?? {}, 50);
        gathered += posts.length;
        expect(
          replyLabels(posts),
          `preset "${definition.id}" source "${ref.module}" leaked replies`,
        ).toEqual([]);
      }

      // Vacuity floor: the preset's sources really returned candidates.
      expect(gathered).toBeGreaterThan(0);
      // A preset runs every one of its enabled sources SEQUENTIALLY here — for_you
      // alone is eight lanes — against a database ten worker processes are also
      // writing to. The default 5s budget is for a single query, not for that.
    }, 30_000);
  }
});

/**
 * The audit, as a gate rather than as prose.
 *
 * A written list of which sources exclude replies is exactly the artefact that
 * rots: nothing fails when a new source is added without anyone deciding its
 * reply policy, which is how the `popular` gap survived. Declaring the policy for
 * every registered source and asserting the declaration COVERS the registry means
 * a new source cannot be added silently — the author is forced to state an intent.
 *
 * This deliberately does NOT assert the behaviour of the `includes-replies`
 * entries. Several of them (`videos`, `media`, `moreLikeThis`, `nearby`,
 * `friendsEngaged`) are discovery surfaces that arguably SHOULD be roots-only;
 * they are recorded here as they are today, not as they ought to be, so the table
 * stays an honest description rather than a claim this change did not make.
 */
describe('reply policy — every registered source has a declared intent', () => {
  type ReplyPolicy = 'roots-only' | 'includes-replies' | 'replies-only' | 'boosts-only';

  const DECLARED_POLICY: Record<string, ReplyPolicy> = {
    // For You lanes — all eight share `buildBaseMatch`.
    following: 'roots-only', // ranked lane; the CHRONOLOGICAL timeline branch keeps replies
    lists: 'roots-only', // ranked lane; the chronological list branch keeps replies
    topic: 'roots-only', // ranked lane; the chronological topic branch keeps replies
    affinity: 'roots-only',
    language: 'roots-only',
    region: 'roots-only',
    trending: 'roots-only',
    globalDiscovery: 'roots-only',
    // Discovery.
    explore: 'roots-only',
    popular: 'roots-only', // also backs the `trending` PRESET
    videos: 'includes-replies', // documented: replies flow through for thread slicing
    media: 'includes-replies', // same; note legacy `buildMediaQuery` DOES exclude them
    popularVideos: 'includes-replies',
    popularMedia: 'includes-replies',
    newVoices: 'roots-only',
    risingCreators: 'roots-only',
    moreLikeThis: 'includes-replies',
    nearby: 'includes-replies',
    // Social graph / conversation.
    friendsEngaged: 'includes-replies',
    repliesFromFollows: 'replies-only',
    topReplies: 'replies-only',
    boostsFromFollows: 'boosts-only',
    mentionsOfMe: 'includes-replies', // a mention usually IS a reply
    hashtagFollows: 'includes-replies',
    starterPack: 'includes-replies',
    onThisDay: 'includes-replies',
    questions: 'includes-replies',
    news: 'includes-replies',
    instance: 'includes-replies',
    links: 'includes-replies',
    quotes: 'includes-replies',
    friendsOfFriends: 'includes-replies',
    curated: 'includes-replies',
    // Viewer-scoped / explicitly requested.
    keywords: 'includes-replies',
    trendTerms: 'includes-replies', // must match what trend DETECTION counts
    accounts: 'includes-replies',
    authored: 'includes-replies', // per-tab: posts=roots, replies=replies, media=roots
    saved: 'includes-replies',
    mutuals: 'includes-replies',
  };

  beforeAll(() => {
    registerSourceModules();
  });

  it('declares a policy for exactly the registered source ids', () => {
    const registered = feedModuleRegistry
      .list()
      .filter((module) => module.kind === 'source')
      .map((module) => module.id)
      .sort();

    // Vacuity floor: the registry really loaded. An empty registry would make the
    // set comparison below trivially true against an empty declaration.
    expect(registered.length).toBeGreaterThan(30);
    expect(registered).toEqual(Object.keys(DECLARED_POLICY).sort());
  });

  it('marks every source the roots-only presets depend on as roots-only', () => {
    for (const definition of [forYouDefinition, exploreDefinition, trendingDefinition]) {
      for (const ref of definition.sources.filter((source) => source.enabled)) {
        expect(DECLARED_POLICY[ref.module], `${definition.id} → ${ref.module}`).toBe('roots-only');
      }
    }
  });

  /**
   * The one `includes-replies` entry this change actually MEASURED rather than
   * read. `videos` is a discovery surface whose definition sets
   * `replyContext: false`, so a reply reaching it renders with no context at all —
   * the same defect as trending, in a feed this change deliberately did not touch
   * (`buildVideosQuery` carries an explicit "replies flow through for thread
   * slicing" rationale that deserves its own decision, not a drive-by edit).
   *
   * Recorded as a characterization test: it asserts today's behaviour so that
   * whoever changes it is forced to come back and update the declaration above,
   * rather than leaving the table quietly wrong.
   */
  it('records that `videos` still returns replies (a finding, not an endorsement)', async () => {
    const posts = await videosSource.gather({ seenPostIds: [] }, {}, 50);
    const labels = posts.map(labelOf);

    // Vacuity floor: the video query matched the seeded video pair at all.
    expect(labels).toContain('videos:root');

    expect(DECLARED_POLICY.videos).toBe('includes-replies');
    expect(labels).toContain('videos:localReply');
  });
});
