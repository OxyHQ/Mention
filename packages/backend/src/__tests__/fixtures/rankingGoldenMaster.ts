/**
 * GOLDEN-MASTER fixtures for the Phase 3 ranking-registry refactor.
 *
 * A diverse, DETERMINISTIC set of scoring cases used to prove the modular signal
 * registry reproduces the pre-refactor `calculatePostScore` output byte-for-byte.
 * The baseline (`rankingGoldenMaster.baseline.json`) was captured by running the
 * PRE-refactor service over these exact cases under a FIXED clock; the golden
 * test asserts the refactored orchestrator reproduces every recorded value.
 *
 * Determinism guarantees:
 *  - All `createdAt`s are ABSOLUTE, expressed as offsets from {@link FIXED_NOW};
 *    the test pins the system clock to `FIXED_NOW`, so every age-based signal
 *    (recency, velocity, trending, cold-start) is reproducible.
 *  - The time-of-day cases build `activeHours` RELATIVE to the fixture's own
 *    local hour ({@link hourOf}) so their match/adjacent/miss outcome is fixed by
 *    construction and independent of the machine timezone.
 *  - No randomness, no network, no Redis — `calculatePostScore` reads only the
 *    supplied post + context.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The fixed wall clock the golden test pins via `vi.setSystemTime`. */
export const FIXED_NOW = Date.parse('2026-07-13T12:00:00.000Z');

/** A post `ageHours` old relative to {@link FIXED_NOW}, as an absolute Date. */
function aged(ageHours: number): Date {
  return new Date(FIXED_NOW - ageHours * HOUR_MS);
}

/** The LOCAL hour of an absolute createdAt — used to build TZ-stable activeHours. */
export function hourOf(createdAt: Date): number {
  return createdAt.getHours();
}

/** The seven scored values captured/asserted per case. */
export interface GoldenResult {
  finalScore: number;
  engagement: number;
  recency: number;
  relationship: number;
  personalization: number;
  quality: number;
  diversity: number;
}

/** Loosely-typed post/context so the fixtures do not couple to internal types. */
type Post = Record<string, unknown>;
type Context = Record<string, unknown>;

export interface GoldenCase {
  name: string;
  userId: string | undefined;
  post: Post;
  context: Context;
}

/** The minimal service surface the harness calls — satisfied by FeedRankingService. */
export interface ScoringService {
  calculatePostScore(
    post: Post,
    userId: string | undefined,
    context: Context,
  ): Promise<number>;
}

/** Base post skeleton; overrides win. Mirrors the shape the ranking code reads. */
function makePost(overrides: Post = {}): Post {
  return {
    _id: 'post',
    oxyUserId: 'author-1',
    createdAt: aged(2),
    type: 'text',
    hashtags: [],
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 0 },
    metadata: {},
    ...overrides,
  };
}

/** A pinned engagement value so a case isolates non-engagement factors. */
function pinnedEngagement(id: string, value: number): Map<string, number> {
  return new Map<string, number>([[id, value]]);
}

/** A full behaviorSets object with the given hidden topics / preferred topic ids. */
function behaviorSets(overrides: Partial<{
  hiddenAuthors: string[];
  mutedAuthors: string[];
  blockedAuthors: string[];
  hiddenTopics: string[];
  preferredTopicIds: string[];
}> = {}) {
  return {
    hiddenAuthors: new Set<string>(overrides.hiddenAuthors ?? []),
    mutedAuthors: new Set<string>(overrides.mutedAuthors ?? []),
    blockedAuthors: new Set<string>(overrides.blockedAuthors ?? []),
    hiddenTopics: new Set<string>((overrides.hiddenTopics ?? []).map((t) => t.toLowerCase())),
    preferredTopicIds: new Set<string>(overrides.preferredTopicIds ?? []),
  };
}

const CLASSIFIED = (scores: Record<string, number>, extra: Post = {}): Post =>
  makePost({
    postClassification: {
      status: 'classified',
      topics: [],
      scores: {
        toxicity: 0,
        constructiveness: 0.5,
        spam: 0,
        quality: 0.5,
        controversy: 0,
        negativity: 0,
        ...scores,
      },
    },
    ...extra,
  });

// A createdAt shared by the time-of-day cases so activeHours can key off it.
const TOD_CREATED = aged(2);
const TOD_HOUR = hourOf(TOD_CREATED);

/**
 * The golden cases. Each pins its inputs; the harness scores the post and records
 * the finalScore + `_rank*` breakdown. Covers the full signal matrix: engagement
 * levels, recency tiers, following/affinity, authority, classified vs baseline vs
 * pending vs none, provenance edge cases, sensitive/NSFW/hidden exclusions,
 * personalization (topic/type/language), thread, federated-boost dampening,
 * missing fields, and the opt-in signals both off and on.
 */
export const GOLDEN_CASES: GoldenCase[] = [
  // --- Baselines / engagement / recency ---
  { name: 'bare-anon', userId: undefined, post: makePost(), context: {} },
  {
    name: 'high-engagement-computed',
    userId: undefined,
    post: makePost({ stats: { likesCount: 40, boostsCount: 12, commentsCount: 8, viewsCount: 300, sharesCount: 3 } }),
    context: {},
  },
  {
    name: 'fresh-under-1h',
    userId: undefined,
    post: makePost({ createdAt: aged(0.5), stats: { likesCount: 5, boostsCount: 1, commentsCount: 2, viewsCount: 40 } }),
    context: {},
  },
  { name: 'aged-12h', userId: undefined, post: makePost({ createdAt: aged(12) }), context: {} },
  { name: 'aged-2d', userId: undefined, post: makePost({ createdAt: aged(48) }), context: {} },
  { name: 'older-than-maxage', userId: undefined, post: makePost({ createdAt: aged(24 * 8) }), context: {} },
  { name: 'invalid-createdAt', userId: undefined, post: makePost({ createdAt: 'not-a-date' }), context: {} },
  { name: 'missing-createdAt', userId: undefined, post: makePost({ createdAt: undefined }), context: {} },
  { name: 'missing-stats', userId: undefined, post: makePost({ stats: undefined }), context: {} },

  // --- Relationship / authority ---
  {
    name: 'following-author',
    userId: 'viewer-1',
    post: makePost({ oxyUserId: 'followed' }),
    context: { followingIdsSet: new Set(['followed']), engagementScoreCache: pinnedEngagement('post', 1) },
  },
  {
    name: 'strong-affinity',
    userId: 'viewer-1',
    post: makePost({ oxyUserId: 'affine' }),
    context: {
      userBehavior: { preferredAuthors: [{ authorId: 'affine', weight: 0.9 }] },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'weak-affinity',
    userId: 'viewer-1',
    post: makePost({ oxyUserId: 'affine2' }),
    context: {
      userBehavior: { preferredAuthors: [{ authorId: 'affine2', weight: 0.5 }] },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'no-relation-viewer',
    userId: 'viewer-1',
    post: makePost({ oxyUserId: 'stranger' }),
    context: { engagementScoreCache: pinnedEngagement('post', 1) },
  },
  {
    name: 'authority-large-account',
    userId: undefined,
    post: makePost({ oxyUserId: 'whale' }),
    context: { authorFollowerCounts: new Map([['whale', 500_000]]), engagementScoreCache: pinnedEngagement('post', 1) },
  },
  {
    name: 'authority-small-account',
    userId: undefined,
    post: makePost({ oxyUserId: 'small' }),
    context: { authorFollowerCounts: new Map([['small', 3]]), engagementScoreCache: pinnedEngagement('post', 1) },
  },

  // --- Quality (engagement-rate heuristic tiers) ---
  {
    name: 'quality-high-rate',
    userId: undefined,
    post: makePost({ stats: { likesCount: 20, boostsCount: 20, commentsCount: 0, viewsCount: 20 } }),
    context: {},
  },
  {
    name: 'quality-low-rate-manyviews',
    userId: undefined,
    post: makePost({ stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 500 } }),
    context: {},
  },
  {
    name: 'quality-tiny-views',
    userId: undefined,
    post: makePost({ stats: { likesCount: 1, boostsCount: 0, commentsCount: 0, viewsCount: 2 } }),
    context: {},
  },

  // --- AI / baseline classification ---
  { name: 'ai-high-quality', userId: undefined, post: CLASSIFIED({ quality: 0.9 }), context: {} },
  { name: 'ai-low-quality', userId: undefined, post: CLASSIFIED({ quality: 0.2 }), context: {} },
  { name: 'ai-high-spam', userId: undefined, post: CLASSIFIED({ spam: 0.9 }), context: {} },
  { name: 'ai-high-toxicity', userId: undefined, post: CLASSIFIED({ toxicity: 0.85 }), context: {} },
  {
    name: 'ai-malformed-scores',
    userId: undefined,
    post: CLASSIFIED({ spam: 1.5, toxicity: -0.2, quality: 2 }),
    context: {},
  },
  {
    name: 'baseline-scored-current-version',
    userId: undefined,
    post: makePost({
      postClassification: {
        status: 'pending',
        topics: [],
        version: 999,
        scores: { spam: 0.9, toxicity: 0, quality: 0.5, constructiveness: 0, controversy: 0, negativity: 0 },
      },
    }),
    context: {},
  },
  {
    name: 'stale-baseline-version',
    userId: undefined,
    post: makePost({
      postClassification: {
        status: 'pending',
        topics: [],
        version: 1,
        scores: { spam: 0.99, toxicity: 0.99, quality: 0, constructiveness: 0, controversy: 0, negativity: 0 },
      },
    }),
    context: {},
  },
  {
    name: 'pending-no-scores',
    userId: undefined,
    post: makePost({ postClassification: { status: 'pending', topics: [] } }),
    context: {},
  },

  // --- Sensitive / hidden exclusions ---
  {
    name: 'sensitive-classifier',
    userId: undefined,
    post: makePost({ postClassification: { status: 'baseline', topics: [], sensitive: true } }),
    context: { engagementScoreCache: pinnedEngagement('post', 1) },
  },
  {
    name: 'sensitive-opted-in',
    userId: undefined,
    post: makePost({ postClassification: { status: 'baseline', topics: [], sensitive: true } }),
    context: { showSensitiveContent: true, engagementScoreCache: pinnedEngagement('post', 1) },
  },
  {
    name: 'nsfw-hashtag',
    userId: undefined,
    post: makePost({ hashtags: ['nsfw'] }),
    context: { engagementScoreCache: pinnedEngagement('post', 1) },
  },
  {
    name: 'hidden-author',
    userId: 'viewer-1',
    post: makePost({ oxyUserId: 'blocked-guy' }),
    context: {
      userBehavior: { hiddenAuthors: ['blocked-guy'] },
      behaviorSets: behaviorSets({ hiddenAuthors: ['blocked-guy'] }),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'blocked-author',
    userId: 'viewer-1',
    post: makePost({ oxyUserId: 'bad-guy' }),
    context: {
      userBehavior: { blockedAuthors: ['bad-guy'] },
      behaviorSets: behaviorSets({ blockedAuthors: ['bad-guy'] }),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'hidden-topic',
    userId: 'viewer-1',
    post: makePost({ hashtags: ['politics'] }),
    context: {
      userBehavior: { hiddenTopics: ['politics'] },
      behaviorSets: behaviorSets({ hiddenTopics: ['politics'] }),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'hidden-topic-with-ai-spam',
    userId: 'viewer-1',
    post: makePost({
      hashtags: ['politics'],
      postClassification: {
        status: 'classified',
        topics: [],
        scores: { spam: 0.9, toxicity: 0, quality: 0.5, constructiveness: 0, controversy: 0, negativity: 0 },
      },
    }),
    context: {
      userBehavior: { hiddenTopics: ['politics'] },
      behaviorSets: behaviorSets({ hiddenTopics: ['politics'] }),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },

  // --- Personalization (topic / type / language) ---
  {
    name: 'topicid-match',
    userId: 'viewer-1',
    post: makePost({ postClassification: { status: 'baseline', topics: ['nba'], topicRefs: [{ name: 'nba', topicId: 'topic-nba' }] } }),
    context: {
      userBehavior: { preferredTopics: [{ topic: 'nba', weight: 0.9, topicId: 'topic-nba' }] },
      behaviorSets: behaviorSets({ preferredTopicIds: ['topic-nba'] }),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'hashtag-topic-match',
    userId: 'viewer-1',
    post: makePost({ hashtags: ['cooking'] }),
    context: {
      userBehavior: { preferredTopics: [{ topic: 'cooking', weight: 0.8 }] },
      behaviorSets: behaviorSets(),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'post-type-pref',
    userId: 'viewer-1',
    post: makePost({ type: 'image' }),
    context: {
      userBehavior: { preferredPostTypes: { image: 8, text: 2 } },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'language-match',
    userId: 'viewer-1',
    post: makePost({ postClassification: { status: 'baseline', topics: [], languages: ['en', 'es'] } }),
    context: {
      userBehavior: { preferredLanguages: ['es'] },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'language-miss',
    userId: 'viewer-1',
    post: makePost({ postClassification: { status: 'baseline', topics: [], languages: ['de', 'fr'] } }),
    context: {
      userBehavior: { preferredLanguages: ['es'] },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },

  // --- Thread / trending / federated dampening ---
  {
    name: 'thread-root-with-replies',
    userId: undefined,
    post: makePost({ threadId: 't1', stats: { likesCount: 2, boostsCount: 0, commentsCount: 5, viewsCount: 30 } }),
    context: {},
  },
  {
    name: 'trending-density',
    userId: undefined,
    post: makePost({ createdAt: aged(1), stats: { likesCount: 60, boostsCount: 10, commentsCount: 10, viewsCount: 200 } }),
    context: {},
  },
  {
    name: 'federated-boosts-dampened',
    userId: undefined,
    post: makePost({ stats: { likesCount: 0, boostsCount: 5, federatedBoostsCount: 5, commentsCount: 0, viewsCount: 0 } }),
    context: {},
  },
  {
    name: 'native-boosts',
    userId: undefined,
    post: makePost({ stats: { likesCount: 0, boostsCount: 5, federatedBoostsCount: 0, commentsCount: 0, viewsCount: 0 } }),
    context: {},
  },

  // --- Time of day (TZ-stable by construction) ---
  {
    name: 'time-of-day-match',
    userId: 'viewer-1',
    post: makePost({ createdAt: TOD_CREATED }),
    context: {
      userBehavior: { activeHours: [TOD_HOUR] },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'time-of-day-adjacent',
    userId: 'viewer-1',
    post: makePost({ createdAt: TOD_CREATED }),
    context: {
      userBehavior: { activeHours: [(TOD_HOUR + 1) % 24] },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'time-of-day-miss',
    userId: 'viewer-1',
    post: makePost({ createdAt: TOD_CREATED }),
    context: {
      userBehavior: { activeHours: [(TOD_HOUR + 6) % 24] },
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },

  // --- Opt-in OFF (enabledSignals absent → preset behavior) ---
  {
    name: 'optin-absent-media-post',
    userId: undefined,
    post: makePost({ content: { media: [{ id: 'm1' }] } }),
    context: { engagementScoreCache: pinnedEngagement('post', 1) },
  },
  {
    name: 'optin-empty-set-nonopt-keys',
    userId: undefined,
    post: makePost({ content: { media: [{ id: 'm1' }] } }),
    context: {
      enabledSignals: new Set(['engagement', 'recency']),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },

  // --- Opt-in ON (single + combined) ---
  {
    name: 'optin-mediaBoost-on',
    userId: undefined,
    post: makePost({ content: { media: [{ id: 'm1' }] } }),
    context: {
      enabledSignals: new Set(['mediaBoost']),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'optin-coldStart-on',
    userId: undefined,
    post: makePost({ createdAt: aged(0.25), oxyUserId: 'newbie' }),
    context: {
      enabledSignals: new Set(['coldStartBoost']),
      authorFollowerCounts: new Map([['newbie', 2]]),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'optin-penalizeSeen-on',
    userId: undefined,
    post: makePost({ _id: 'seen-post' }),
    context: {
      enabledSignals: new Set(['penalizeSeen']),
      seenPostIdsSet: new Set(['seen-post']),
      engagementScoreCache: pinnedEngagement('seen-post', 1),
    },
  },
  {
    name: 'optin-verified-on',
    userId: undefined,
    post: makePost({ oxyUserId: 'vip' }),
    context: {
      enabledSignals: new Set(['verifiedBoost']),
      authorVerified: new Map([['vip', true]]),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'optin-socialProof-on',
    userId: undefined,
    post: makePost({ _id: 'sp-post' }),
    context: {
      enabledSignals: new Set(['socialProof']),
      networkEngagerCounts: new Map([['sp-post', 3]]),
      engagementScoreCache: pinnedEngagement('sp-post', 1),
    },
  },
  {
    name: 'optin-dwell-on',
    userId: undefined,
    post: makePost({ _id: 'dw-post' }),
    context: {
      enabledSignals: new Set(['dwellTime']),
      dwellAverages: new Map([['dw-post', 8000]]),
      engagementScoreCache: pinnedEngagement('dw-post', 1),
    },
  },
  {
    name: 'optin-novelty-on',
    userId: 'viewer-1',
    post: makePost({ postClassification: { status: 'baseline', topics: ['space'], topicRefs: [{ name: 'space' }] } }),
    context: {
      enabledSignals: new Set(['noveltyBoost']),
      viewerRecentTopics: new Set(['cooking']),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'optin-reciprocity-on',
    userId: 'viewer-1',
    post: makePost({ oxyUserId: 'mutual-pal' }),
    context: {
      enabledSignals: new Set(['reciprocityBoost']),
      userBehavior: { preferredAuthors: [{ authorId: 'mutual-pal', weight: 0.9 }] },
      mutualIdsSet: new Set(['mutual-pal']),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'optin-positivity-conversational-on',
    userId: undefined,
    post: makePost({
      postClassification: {
        status: 'classified',
        topics: [],
        sentiment: 'positive',
        scores: { toxicity: 0, constructiveness: 1, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
      },
    }),
    context: {
      enabledSignals: new Set(['positivity', 'conversational']),
      engagementScoreCache: pinnedEngagement('post', 1),
    },
  },
  {
    name: 'optin-many-combined',
    userId: 'viewer-1',
    post: makePost({
      _id: 'combo-post',
      oxyUserId: 'combo-author',
      createdAt: aged(0.25),
      content: { media: [{ id: 'm1' }] },
      postClassification: { status: 'classified', topics: ['space'], topicRefs: [{ name: 'space' }], sentiment: 'positive', scores: { toxicity: 0, constructiveness: 0.8, spam: 0, quality: 0.9, controversy: 0, negativity: 0 } },
      stats: { likesCount: 3, boostsCount: 1, commentsCount: 4, viewsCount: 50 },
    }),
    context: {
      enabledSignals: new Set([
        'mediaBoost', 'positivity', 'conversational', 'coldStartBoost',
        'penalizeSeen', 'verifiedBoost', 'dwellTime', 'socialProof',
        'reciprocityBoost', 'noveltyBoost',
      ]),
      userBehavior: {
        preferredAuthors: [{ authorId: 'combo-author', weight: 0.9 }],
        preferredTopics: [{ topic: 'space', weight: 0.9, topicId: 'topic-space' }],
        activeHours: [hourOf(aged(0.25))],
      },
      behaviorSets: behaviorSets({ preferredTopicIds: ['topic-space'] }),
      authorFollowerCounts: new Map([['combo-author', 5]]),
      authorVerified: new Map([['combo-author', true]]),
      seenPostIdsSet: new Set(['combo-post']),
      networkEngagerCounts: new Map([['combo-post', 4]]),
      dwellAverages: new Map([['combo-post', 12000]]),
      mutualIdsSet: new Set(['combo-author']),
      viewerRecentTopics: new Set(['cooking']),
    },
  },

  // --- Combined realistic viewer case (no opt-in) ---
  {
    name: 'realistic-following-classified',
    userId: 'viewer-2',
    post: makePost({
      oxyUserId: 'followed-2',
      createdAt: aged(3),
      hashtags: ['tech'],
      threadId: 'thr',
      postClassification: {
        status: 'classified',
        topics: ['technology'],
        topicRefs: [{ name: 'technology', topicId: 'topic-tech' }],
        languages: ['en'],
        scores: { toxicity: 0.05, constructiveness: 0.7, spam: 0.02, quality: 0.8, controversy: 0.1, negativity: 0.05 },
      },
      stats: { likesCount: 12, boostsCount: 3, federatedBoostsCount: 1, commentsCount: 6, viewsCount: 120, sharesCount: 2 },
    }),
    context: {
      followingIdsSet: new Set(['followed-2']),
      userBehavior: {
        preferredTopics: [{ topic: 'tech', weight: 0.8, topicId: 'topic-tech' }],
        preferredLanguages: ['en'],
        preferredPostTypes: { text: 6, image: 4 },
      },
      behaviorSets: behaviorSets({ preferredTopicIds: ['topic-tech'] }),
      authorFollowerCounts: new Map([['followed-2', 12_000]]),
      feedSettings: { recency: { halfLifeHours: 18, maxAgeHours: 120 } },
    },
  },
];

/**
 * Score one case with the given service and return the finalScore plus the
 * `_rank*` breakdown the orchestrator attaches to the post.
 */
export async function runGoldenCase(
  service: ScoringService,
  testCase: GoldenCase,
): Promise<GoldenResult> {
  const post = testCase.post;
  const finalScore = await service.calculatePostScore(post, testCase.userId, testCase.context);
  return {
    finalScore,
    engagement: post._rankEngagement as number,
    recency: post._rankRecency as number,
    relationship: post._rankRelationship as number,
    personalization: post._rankPersonalization as number,
    quality: post._rankQuality as number,
    diversity: post._rankDiversity as number,
  };
}
