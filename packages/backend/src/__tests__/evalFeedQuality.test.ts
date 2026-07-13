import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import mongoose from 'mongoose';
import {
  runFeedQualityEval,
  buildClassifyInput,
  percentiles,
  assembleCandidates,
  computeOnlineEngagement,
  aggregateOnlineByBucket,
  type EvalCandidate,
  type EvalGateModule,
  type OnlineInteractionRow,
} from '../scripts/evalFeedQuality';
import { bucketForDiscoveryGate } from '../mtn/feed/discoveryGateExperiment';
import {
  resolveLabeledPosts,
  type LabelResolverDeps,
  type LabeledActor,
} from '../scripts/fixtures/feedQualityLabels';
import { baselineContentClassifier } from '../services/BaselineContentClassifier';
import {
  minLengthFilter,
  lowEffortGateFilter,
  nativeEngagementFilter,
  minQualityFilter,
} from '../mtn/feed/engine/filters';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';
import type { RankablePost } from '../services/ranking/signalContext';
import type { FilterModule } from '../mtn/feed/engine/types';

/**
 * PHASE 7 — offline feed-quality eval harness.
 *
 * Exercises the exported PURE `runFeedQualityEval` over a fixed fixture set built
 * from the five real junk shapes the user reported, using the REAL v5 classifier
 * and the REAL For You discovery-gate filter predicates plus a deterministic
 * ranking stub. Asserts every junk label is flagged (gated) and a good post
 * survives, and that the reported metrics reflect that.
 */

const GATE = MtnConfig.feed.discoveryGate;
const OLD = new Date(Date.now() - GATE.freshnessGraceMs - 60 * 60 * 1000); // outside the freshness grace
const NOW = new Date();

const oid = (n: number): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(`5e${n.toString().padStart(22, '0')}`);

/**
 * Build a lean candidate post typed as `CandidatePost`. Extras are funneled
 * through `Record<string, unknown>` (as the engine's own test `makePost` does), so
 * fields like `federation` are index-typed and assign cleanly to `CandidatePost`.
 */
function leanPost(n: number, extra: Record<string, unknown> = {}): CandidatePost {
  return { _id: oid(n), ...extra };
}

/** Build the exact For You gate modules from the real filter modules (no registry needed). */
function gateModule(filter: FilterModule, params: Record<string, unknown>): EvalGateModule {
  if (!filter.keep) throw new Error(`filter ${filter.id} has no keep predicate`);
  return { id: filter.id, keep: filter.keep, params };
}

const GATE_MODULES: EvalGateModule[] = [
  gateModule(minLengthFilter, { minLength: GATE.minTextLength, forYouGate: true }),
  gateModule(lowEffortGateFilter, { forYouGate: true }),
  gateModule(nativeEngagementFilter, { forYouGate: true }),
  gateModule(minQualityFilter, { forYouGate: true }),
];

/** Deterministic ranking stub: score by native engagement (pure, no DB/Oxy). */
const RANKING_STUB = {
  calculatePostScore: async (post: RankablePost): Promise<number> => {
    const stats = post.stats ?? {};
    const engagement = (stats.likesCount ?? 0) + (stats.commentsCount ?? 0);
    const score = engagement + 1;
    post.finalScore = score;
    post._rankEngagement = score;
    return score;
  },
};

interface FixtureSpec {
  n: number;
  text: string;
  label?: 'junk' | 'good';
  acct?: string;
  actorType?: string;
  domain?: string;
  stats?: Record<string, number>;
  createdAt: Date;
  federated: boolean;
  hasImage?: boolean;
}

function makeCandidate(spec: FixtureSpec): EvalCandidate {
  const post = leanPost(spec.n, {
    oxyUserId: `author-${spec.n}`,
    createdAt: spec.createdAt,
    content: spec.hasImage
      ? { text: spec.text, media: [{ type: 'image', id: 'img-1' }] }
      : { text: spec.text },
    stats: spec.stats ?? { likesCount: 0, commentsCount: 0, boostsCount: 0, federatedBoostsCount: 0 },
    hashtags: [],
    ...(spec.federated ? { federation: { actorUri: `https://${spec.domain}/users/u${spec.n}` } } : {}),
  });
  const actor: LabeledActor | undefined = spec.federated
    ? { uri: `https://${spec.domain}/users/u${spec.n}`, acct: spec.acct ?? `u${spec.n}@${spec.domain}`, domain: spec.domain ?? 'example.social', type: spec.actorType ?? 'Person', oxyUserId: `author-${spec.n}` }
    : undefined;
  return {
    post,
    source: spec.label ? 'labeled' : 'random',
    label: spec.label,
    acct: spec.acct,
    actor,
  };
}

/** The five real junk shapes + one good post that MUST survive. */
function buildFixtureCandidates(): EvalCandidate[] {
  return [
    makeCandidate({
      n: 1,
      label: 'junk',
      acct: 'neobrown9_m@misskey.io',
      domain: 'misskey.io',
      actorType: 'Person',
      text: ':oyaki: :blobcat: :blobcatgiggle: :meowparty: :oyaki:',
      createdAt: OLD,
      federated: true,
    }),
    makeCandidate({
      n: 2,
      label: 'junk',
      acct: 'denfaminicogamer@rss-mstdn.studiofreesia.com',
      domain: 'rss-mstdn.studiofreesia.com',
      actorType: 'Service',
      text: 'New game announced for PS5 https://example.com/news/12345 #game #news #ps5 #gaming #japan',
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 1, federatedBoostsCount: 1 },
      createdAt: OLD,
      federated: true,
    }),
    makeCandidate({
      n: 3,
      label: 'junk',
      acct: 'honkhase@chaos.social',
      domain: 'chaos.social',
      actorType: 'Person',
      text: 'Guten Morgen zusammen. Heute wird ein sehr schoener Tag mit viel Sonnenschein und guter Laune fuer alle.',
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 3, federatedBoostsCount: 3 },
      createdAt: OLD,
      federated: true,
    }),
    makeCandidate({
      n: 4,
      label: 'junk',
      acct: 'isurandil@mastodon.online',
      domain: 'mastodon.online',
      actorType: 'Person',
      text: 'Endlich Feierabend. Jetzt noch schnell einkaufen gehen und dann gemuetlich einen Film schauen heute Abend.',
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 3, federatedBoostsCount: 3 },
      createdAt: OLD,
      federated: true,
    }),
    makeCandidate({
      n: 5,
      label: 'junk',
      acct: 'davidrevoy@framapiaf.org',
      domain: 'framapiaf.org',
      actorType: 'Person',
      text: 'Nouveau dessin pour mon webcomic Pepper et Carrot, disponible librement sous licence ouverte pour tous.',
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 5, federatedBoostsCount: 5 },
      createdAt: OLD,
      federated: true,
      hasImage: true,
    }),
    // A GOOD federated post: real English prose, genuine NATIVE engagement, recent.
    makeCandidate({
      n: 9,
      label: 'good',
      acct: 'realhuman@mastodon.social',
      domain: 'mastodon.social',
      actorType: 'Person',
      text: 'Really enjoyed shipping the new feed ranking pipeline today. Sharing what we learned about candidate generation and safety gating with everyone.',
      stats: { likesCount: 6, commentsCount: 3, boostsCount: 1, federatedBoostsCount: 0 },
      createdAt: NOW,
      federated: true,
    }),
  ];
}

async function runFixtureEval(viewerLanguages: string[] = ['en']) {
  return runFeedQualityEval({
    candidates: buildFixtureCandidates(),
    classifier: baselineContentClassifier,
    ranking: RANKING_STUB,
    gateModules: GATE_MODULES,
    context: { viewerLanguages },
    viewerId: 'viewer-1',
    topK: 10,
  });
}

describe('runFeedQualityEval', () => {
  it('flags every labeled junk post and keeps the good post', async () => {
    const report = await runFixtureEval();

    const rowsById = new Map(report.rows.map((r) => [r.id, r]));
    for (const n of [1, 2, 3, 4, 5]) {
      const row = rowsById.get(oid(n).toString());
      expect(row?.label).toBe('junk');
      expect(row?.gated).toBe(true);
      expect(row?.gateReason).toBeDefined();
    }

    const good = rowsById.get(oid(9).toString());
    expect(good?.label).toBe('good');
    expect(good?.gated).toBe(false);
  });

  it('reports junk-in-top-K dropping to zero after the gate', async () => {
    const report = await runFixtureEval();

    // Pre-gate the labeled junk is present in the pool; post-gate it is all removed.
    expect(report.junkInTopKPreGate.count).toBeGreaterThan(0);
    expect(report.junkInTopK.count).toBe(0);
    expect(report.junkInTopK.rate).toBe(0);
  });

  it('reports gate precision/recall against the labels', async () => {
    const report = await runFixtureEval();

    expect(report.gate.labeledJunk).toBe(5);
    expect(report.gate.labeledGood).toBe(1);
    expect(report.gate.rejectedJunk).toBe(5);
    expect(report.gate.rejectedGood).toBe(0);
    expect(report.gate.recall).toBe(1);
    expect(report.gate.precision).toBe(1); // no good post rejected
    expect(Object.values(report.gate.reasons).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('reports the shortcode-only post as low-effort and the off-language posts as engagement-gated', async () => {
    const report = await runFixtureEval();
    const rowsById = new Map(report.rows.map((r) => [r.id, r]));

    expect(rowsById.get(oid(1).toString())?.gateReason).toBe('lowEffortGate');
    // German / French off-language posts fail the native-engagement floor.
    for (const n of [3, 4, 5]) {
      expect(rowsById.get(oid(n).toString())?.gateReason).toBe('nativeEngagement');
    }
  });

  it('computes trusted-quality distribution and federated share', async () => {
    const report = await runFixtureEval();

    // Every candidate is federated in this fixture set.
    expect(report.federatedShare).toBe(1);
    // The freshly-stamped v5 scores are trusted, so quality percentiles are populated.
    expect(report.quality.trustedCount).toBe(report.totalCandidates);
    expect(report.quality.all.n).toBe(report.totalCandidates);
  });

  it('reports language-match rate against the viewer languages', async () => {
    const report = await runFixtureEval(['en']);
    // The good + shortcode posts vary; at least the German/French declare off-languages,
    // so the match rate is strictly between 0 and 1.
    expect(report.languageMatchRate).not.toBeNull();
    expect(report.languageMatchRate).toBeGreaterThan(0);
    expect(report.languageMatchRate).toBeLessThan(1);
  });

  it('reports language-match rate as null when the viewer languages are unknown', async () => {
    const report = await runFixtureEval([]);
    expect(report.languageMatchRate).toBeNull();
  });
});

describe('buildClassifyInput', () => {
  it('threads the federated actor type + instance domain into the classifier input', () => {
    const [candidate] = buildFixtureCandidates();
    const input = buildClassifyInput(candidate);
    expect(input.isFederated).toBe(true);
    expect(input.actorType).toBe('Person');
    expect(input.instanceDomain).toBe('misskey.io');
    expect(input.text).toContain(':oyaki:');
  });
});

describe('percentiles', () => {
  it('computes nearest-rank p10/p50/p90', () => {
    const p = percentiles([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(p.n).toBe(10);
    expect(p.p50).toBeCloseTo(0.4, 5);
    expect(p.p90).toBeCloseTo(0.8, 5);
  });

  it('returns zeros for an empty sample', () => {
    expect(percentiles([])).toEqual({ p10: 0, p50: 0, p90: 0, n: 0 });
  });
});

describe('assembleCandidates', () => {
  const post = (n: number, federation?: { actorUri: string }): CandidatePost =>
    leanPost(n, { oxyUserId: `a${n}`, ...(federation ? { federation } : {}) });

  it('dedupes by _id with the labeled copy winning over random/forYou', () => {
    const labeled = [{ label: 'junk' as const, reason: 'r', acct: 'x@y', post: post(1), actor: undefined }];
    const merged = assembleCandidates(
      labeled,
      [post(1), post(2, { actorUri: 'https://y/users/2' })],
      [post(3)],
      new Map([['https://y/users/2', { uri: 'https://y/users/2', acct: 'two@y', domain: 'y', type: 'Person' }]]),
    );
    const byId = new Map(merged.map((c) => [String(c.post._id), c]));
    expect(byId.get(oid(1).toString())?.source).toBe('labeled');
    expect(byId.get(oid(2).toString())?.source).toBe('random');
    expect(byId.get(oid(2).toString())?.actor?.acct).toBe('two@y');
    expect(byId.get(oid(3).toString())?.source).toBe('forYou');
    expect(merged).toHaveLength(3);
  });
});

describe('online engagement (from FeedInteraction)', () => {
  it('computes engagement-per-impression and report-per-impression', () => {
    const report = computeOnlineEngagement({ impression: 100, like: 8, reply: 2, boost: 1, report: 3 });
    expect(report.impressions).toBe(100);
    expect(report.engagements).toBe(11); // 8 + 2 + 1
    expect(report.reports).toBe(3);
    expect(report.engagementPerImpression).toBeCloseTo(0.11, 5);
    expect(report.reportPerImpression).toBeCloseTo(0.03, 5);
  });

  it('returns zero ratios with no impressions (no divide-by-zero)', () => {
    const report = computeOnlineEngagement({ like: 5 });
    expect(report.engagementPerImpression).toBe(0);
    expect(report.reportPerImpression).toBe(0);
  });

  it('splits engagement by the deterministic A/B bucket', () => {
    const rows: OnlineInteractionRow[] = [
      { userId: 'u1', event: 'impression', count: 50 },
      { userId: 'u1', event: 'like', count: 5 },
      { userId: 'u2', event: 'impression', count: 50 },
      { userId: 'u2', event: 'report', count: 2 },
    ];
    const bucketOf = (userId: string) => bucketForDiscoveryGate(userId);
    const online = aggregateOnlineByBucket(rows, bucketOf);

    expect(online.overall.impressions).toBe(100);
    // Every user lands in exactly one deterministic bucket; totals reconcile.
    const summed = Object.values(online.byBucket).reduce((sum, r) => sum + r.impressions, 0);
    expect(summed).toBe(100);
    // u1 and u2 are placed by their stable hash, so the split is reproducible.
    expect(online.byBucket[bucketForDiscoveryGate('u1')].impressions).toBeGreaterThanOrEqual(50);
  });
});

describe('resolveLabeledPosts', () => {
  const actor: LabeledActor = { uri: 'https://misskey.io/users/n', acct: 'neobrown9_m@misskey.io', domain: 'misskey.io', type: 'Person' };

  function deps(overrides: Partial<LabelResolverDeps<CandidatePost>> = {}): LabelResolverDeps<CandidatePost> {
    return {
      findActorByAcct: async (acct) => (acct === actor.acct ? actor : null),
      findActorByUri: async (uri) => (uri === actor.uri ? actor : null),
      findRecentPostsForActor: async () => [
        leanPost(1, { federation: { actorUri: actor.uri } }),
        leanPost(2, { federation: { actorUri: actor.uri } }),
      ],
      findPostById: async () => null,
      findPostByActivityId: async () => null,
      actorUriOf: (post) => {
        const federation = (post as Record<string, unknown>).federation as { actorUri?: string } | undefined;
        return federation?.actorUri;
      },
      ...overrides,
    };
  }

  it('joins an acct entry to the actor recent posts', async () => {
    const resolved = await resolveLabeledPosts(
      [{ label: 'junk', reason: 'shortcode', acct: actor.acct }],
      deps(),
    );
    expect(resolved).toHaveLength(2);
    expect(resolved[0].label).toBe('junk');
    expect(resolved[0].acct).toBe(actor.acct);
    expect(resolved[0].actor?.type).toBe('Person');
  });

  it('skips an acct entry that resolves to no actor', async () => {
    const resolved = await resolveLabeledPosts(
      [{ label: 'junk', reason: 'x', acct: 'missing@nowhere' }],
      deps(),
    );
    expect(resolved).toHaveLength(0);
  });

  it('resolves a postId entry directly and attaches its actor', async () => {
    const resolved = await resolveLabeledPosts(
      [{ label: 'good', reason: 'quality', postId: oid(7).toString() }],
      deps({
        findPostById: async () => leanPost(7, { federation: { actorUri: actor.uri } }),
      }),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].label).toBe('good');
    expect(resolved[0].actor?.acct).toBe(actor.acct);
  });
});
