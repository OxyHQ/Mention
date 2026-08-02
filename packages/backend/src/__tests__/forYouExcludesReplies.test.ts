import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * For You must rank thread ROOTS, not replies — enforced against a REAL mongod.
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
 * ## Why a real database rather than a mocked `Post.find`
 *
 * The bug is a missing clause in a Mongo match, so a test that inspects the match
 * object can only assert that some expected shape is present — it re-states the
 * fix rather than checking its effect, and it passes just as happily if the clause
 * is present but wrong (matching `parentPostId` only, spelling `inReplyTo` wrong,
 * losing the `''` sentinel, or landing under an `$or` a later builder clobbers).
 * Executing the REAL match objects against a REAL mongod over a pool whose reply
 * share is known removes that whole class of false pass: the assertion is on the
 * documents that come back.
 *
 * Every lane is exercised INDIVIDUALLY so a regression names the source that
 * leaked, and each lane's fixture pair is a reply and a root that both match that
 * lane's own predicate — so "no replies returned" can never be satisfied by a lane
 * that quietly matched nothing (the root assertion is the vacuity floor).
 *
 * Replies are seeded in BOTH encodings, because the local link and the federated
 * IRI diverge exactly where it matters: a federated reply whose parent never
 * resolved carries `federation.inReplyTo` with a null `parentPostId`, so a filter
 * reading the local link alone lets precisely those through (see `utils/postReply`).
 * A third fixture carries `federation.inReplyTo: ''` and must be treated as a ROOT,
 * pinning the empty-string sentinel.
 */

vi.unmock('mongoose');

const mongoose = (await import('mongoose')).default;
const { Post } = await import('../models/Post');
const { isReplyClause, isReplyPost } = await import('../utils/postReply');
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

/** A parent that exists locally, so a local reply's `parentPostId` is realistic. */
const PARENT_ID = new mongoose.Types.ObjectId().toString();

/** How a seeded post encodes (or does not encode) its parent. */
type ParentLink = 'root' | 'emptyIriRoot' | 'localReply' | 'federatedReply';

interface SeedSpec {
  /** Stable label used in assertions and failure messages. */
  label: string;
  author: string;
  link: ParentLink;
  /** Lane-selecting fields (topics / languages / region). */
  extra?: Record<string, unknown>;
  /**
   * Newest + most engaged, so this fixture survives a lane's `limit()` whatever
   * else is in the collection. Set for the two lanes that select EVERY post
   * (trending, global): their per-source caps are 25 and 20, small enough that a
   * regression which floods the pool with replies could otherwise push their own
   * root past the cap and turn a leak into a confusing vacuity failure.
   */
  priority?: boolean;
}

/** Fixture timestamps: recent enough for every lane's recency window. */
const NOW = Date.now();

function parentFields(link: ParentLink): Record<string, unknown> {
  switch (link) {
    case 'root':
      return { parentPostId: null };
    case 'emptyIriRoot':
      // Not a reply: the empty IRI is the "no parent" sentinel, not a parent.
      return { parentPostId: null, federation: { inReplyTo: '' } };
    case 'localReply':
      return { parentPostId: PARENT_ID };
    case 'federatedReply':
      // The shape a bare `parentPostId` check misses entirely.
      return { parentPostId: null, federation: { inReplyTo: 'https://remote.example/notes/9' } };
  }
}

/**
 * A raw feed-eligible post document. Inserted through the driver rather than the
 * Mongoose model deliberately: the model's pre-validate hooks would normalize
 * `parentPostId` / `federation` and the fixtures exist precisely to pin those two
 * encodings byte-for-byte.
 */
function buildDoc(spec: SeedSpec): Record<string, unknown> {
  return {
    _id: new mongoose.Types.ObjectId(),
    oxyUserId: spec.author,
    authorship: [{ oxyUserId: spec.author, role: 'owner', status: 'accepted' }],
    visibility: 'public',
    status: 'published',
    type: 'text',
    content: { variants: [{ source: 'author', text: spec.label }] },
    createdAt: new Date(spec.priority ? NOW : NOW - 60 * 60 * 1000),
    updatedAt: new Date(NOW),
    // Non-zero so the engagement-sorted lanes (trending, popular) rank them.
    stats: {
      likesCount: spec.priority ? 100 : 5,
      boostsCount: 1,
      commentsCount: 2,
      federatedBoostsCount: 0,
    },
    hashtags: [],
    ...parentFields(spec.link),
    ...(spec.extra ?? {}),
  };
}

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
  // Sentinel: an empty `inReplyTo` is NOT a parent, so this must survive every lane.
  { label: 'sentinel:emptyIriRoot', author: OTHER_AUTHOR, link: 'emptyIriRoot' },
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
 * The seeded documents, built ONCE so their ids can be mapped back to labels.
 * The label cannot ride on the document itself: every lane projects
 * {@link FEED_FIELDS}, which would drop an extra field and leave assertions
 * comparing opaque ObjectIds.
 */
const SEED_DOCS = SEEDS.map(buildDoc);

const LABEL_BY_ID = new Map(
  SEED_DOCS.map((doc, index) => [String(doc._id), SEEDS[index].label]),
);

/** The label a candidate was seeded with — what failure messages name. */
function labelOf(post: CandidatePost): string {
  const id = String(post._id);
  return LABEL_BY_ID.get(id) ?? `unseeded:${id}`;
}

function replyLabels(posts: CandidatePost[]): string[] {
  return posts.filter((post) => isReplyPost(post)).map(labelOf);
}

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'foryou-replies' });
  await Post.collection.insertMany(SEED_DOCS);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe('For You candidate pool — the fixture universe', () => {
  it('holds a substantial reply share, so the exclusion tests are not vacuous', async () => {
    const total = await Post.countDocuments({ visibility: 'public', status: 'published' });
    const replies = await Post.countDocuments({
      visibility: 'public',
      status: 'published',
      ...isReplyClause(),
    });

    // Mirrors the production shape this fix targets (47.1% replies): if the
    // fixtures ever stopped containing replies, every assertion below would pass
    // for the wrong reason.
    expect(total).toBe(SEEDS.length);
    expect(replies).toBe(SEEDS.filter((s) => s.link !== 'root' && s.link !== 'emptyIriRoot').length);
    expect(replies / total).toBeGreaterThan(0.4);
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
    expect(labels).toContain('sentinel:emptyIriRoot');

    // The measurement this change exists for. The seeded universe is 16 replies
    // out of 25 posts (64%, above the 47.1% measured in production); the ranked
    // pool that comes out of it is 0%.
    expect(replyLabels(pool)).toEqual([]);
    expect(pool.length).toBe(SEEDS.filter((s) => s.link === 'root' || s.link === 'emptyIriRoot').length);
  });
});

describe('popular source — anonymous For You + never-blank fallback', () => {
  it('serves roots only', async () => {
    const posts = await popularSource.gather({}, {}, 50);

    // Vacuity floor: the source returned real candidates from the seeded pool.
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.map(labelOf)).toContain('sentinel:emptyIriRoot');

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
    });
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
    // A lane holds ORIGINAL posts only — a reply is refused a lane at the write
    // boundary — so there is nothing for a roots-only clause to exclude.
    lane: 'includes-replies',
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
