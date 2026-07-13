import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import {
  passesLowEffortGate,
  passesNativeEngagementOrMatch,
  matchesViewerInterests,
} from '../mtn/feed/engine/filters';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';
import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';

/**
 * PHASE 4b DISCOVERY GATE — hard filters for OBJECTIVE junk only.
 *
 * These assert the reusable PURE predicates directly (the FilterModule wrappers
 * are thin), using reconstructed candidate docs of the five real junk shapes the
 * user reported plus legitimate/personalized posts that MUST survive. The gate is
 * evaluated in ENFORCE mode here (the predicate returns keep/reject); shadow mode
 * is exercised at the engine level (`discoveryGateEngine.test.ts`).
 */

const GATE = MtnConfig.feed.discoveryGate;

const LOW_EFFORT_CFG = {
  minMeaningfulTextLength: GATE.minMeaningfulTextLength,
  spamRejectThreshold: GATE.spamRejectThreshold,
  qualityRejectThreshold: GATE.qualityRejectThreshold,
};
const NATIVE_CFG = {
  minNativeEngagement: GATE.minNativeEngagement,
  strongTopicWeight: GATE.strongTopicWeight,
  freshnessGraceMs: GATE.freshnessGraceMs,
};

/** A createdAt safely OUTSIDE the freshness grace window. */
const OLD = new Date(Date.now() - GATE.freshnessGraceMs - 60_000);
/** A createdAt safely INSIDE the freshness grace window. */
const FRESH = new Date(Date.now() - 60_000);

/** Trusted-provenance classification scores (baseline stamped at the current version). */
function classified(scores: {
  spam: number;
  quality: number;
  toxicity?: number;
  constructiveness?: number;
  controversy?: number;
  negativity?: number;
}, languages?: string[]) {
  return {
    status: 'baseline' as const,
    version: BASELINE_CLASSIFIER_VERSION,
    scores: {
      spam: scores.spam,
      toxicity: scores.toxicity ?? 0,
      quality: scores.quality,
      constructiveness: scores.constructiveness ?? 0.5,
      controversy: scores.controversy ?? 0,
      negativity: scores.negativity ?? 0,
    },
    ...(languages ? { languages } : {}),
  };
}

// The discovery-gate predicates never read `federation`; it is intentionally
// omitted so the candidate shape stays minimal and the gate's inputs are explicit.
function post(extra: Record<string, unknown> = {}): CandidatePost {
  return {
    _id: 'p',
    oxyUserId: 'author',
    createdAt: OLD,
    stats: { likesCount: 0, commentsCount: 0, boostsCount: 0, federatedBoostsCount: 0 },
    ...extra,
  };
}

/** An empty viewer context (anonymous / no learned behavior). */
const EMPTY_CTX: FeedEngineContext = {};

// ─── The five reported junk shapes ───────────────────────────────────────────

describe('discovery gate — the 5 reported junk shapes are rejected', () => {
  it('#1 @neobrown9_m@misskey.io — custom-emoji SHORTCODE-only (ja): rejected by lowEffortGate', () => {
    const junk = post({
      content: { text: ':oyaki::oyaki: :blobcat_thinking: :ablobcatwave:' },
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 1, federatedBoostsCount: 1 },
      postClassification: { languages: ['ja'] },
    });
    // No real prose + no media/poll → hard rejected regardless of provenance.
    expect(passesLowEffortGate(junk, LOW_EFFORT_CFG)).toBe(false);
  });

  it('#2 @denfaminicogamer@rss-mstdn — RSS news bot (ja): rejected by lowEffortGate (spam) AND engagement', () => {
    const junk = post({
      content: { text: 'https://news.example/article-123 #ゲーム #news #ニュース' },
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 1, federatedBoostsCount: 1 },
      // F6's bot detector raises the deterministic spam score for an RSS/link mirror.
      postClassification: classified({ spam: 0.9, quality: 0.15 }, ['ja']),
    });
    expect(passesLowEffortGate(junk, LOW_EFFORT_CFG)).toBe(false);
    // Zero native engagement, off-interest, not fresh → also fails the engagement gate.
    expect(passesNativeEngagementOrMatch(junk, EMPTY_CTX, NATIVE_CFG)).toBe(false);
  });

  it('#3 @honkhase@chaos.social — legitimate GERMAN prose (de): PASSES lowEffort, fails engagement', () => {
    const german = post({
      content: {
        text: 'Guten Morgen zusammen! Heute wird ein wunderbarer Tag, die Sonne scheint über der ganzen Stadt.',
      },
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 3, federatedBoostsCount: 3 },
      postClassification: classified({ spam: 0.05, quality: 0.6 }, ['de']),
    });
    // GUARD AGAINST FALSE POSITIVE: real prose is never low-effort junk.
    expect(passesLowEffortGate(german, LOW_EFFORT_CFG)).toBe(true);
    // But 3 boosts are ALL federated → 0 native engagement; off-interest, not fresh → dropped.
    expect(passesNativeEngagementOrMatch(german, EMPTY_CTX, NATIVE_CFG)).toBe(false);
  });

  it('#4 @isurandil@mastodon.online — GERMAN (de): passes lowEffort, fails engagement', () => {
    const german = post({
      content: { text: 'Ich habe gerade ein interessantes Buch über die Geschichte Europas gelesen.' },
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 3, federatedBoostsCount: 3 },
      postClassification: classified({ spam: 0.05, quality: 0.55 }, ['de']),
    });
    expect(passesLowEffortGate(german, LOW_EFFORT_CFG)).toBe(true);
    expect(passesNativeEngagementOrMatch(german, EMPTY_CTX, NATIVE_CFG)).toBe(false);
  });

  it('#5 @davidrevoy@framapiaf.org — FRENCH webcomic (fr) with media: passes lowEffort, fails engagement', () => {
    const webcomic = post({
      content: {
        text: 'Nouvelle page de Pepper & Carrot est disponible !',
        media: [{ id: 'img1', type: 'image' }],
      },
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 5, federatedBoostsCount: 5 },
      postClassification: classified({ spam: 0.05, quality: 0.7 }, ['fr']),
    });
    // Has media + normal scores → lowEffort keeps it.
    expect(passesLowEffortGate(webcomic, LOW_EFFORT_CFG)).toBe(true);
    // 5 federated boosts → 0 native; off-interest, not fresh → dropped by engagement gate.
    expect(passesNativeEngagementOrMatch(webcomic, EMPTY_CTX, NATIVE_CFG)).toBe(false);
  });
});

// ─── lowEffortGate branch behavior ───────────────────────────────────────────

describe('lowEffortGate predicate', () => {
  it('rejects an emoji-only post with no media', () => {
    expect(passesLowEffortGate(post({ content: { text: '🔥🔥🚀✨' } }), LOW_EFFORT_CFG)).toBe(false);
  });

  it('KEEPS an emoji-only post that carries media (media rescues it)', () => {
    const withMedia = post({ content: { text: '🔥🔥', media: [{ id: 'm', type: 'image' }] } });
    expect(passesLowEffortGate(withMedia, LOW_EFFORT_CFG)).toBe(true);
  });

  it('rejects a trusted HIGH-SPAM post', () => {
    const spammy = post({
      content: { text: 'Buy cheap followers now at spam-site dot com, best deal ever, limited time!!!' },
      postClassification: classified({ spam: 0.85, quality: 0.5 }),
    });
    expect(passesLowEffortGate(spammy, LOW_EFFORT_CFG)).toBe(false);
  });

  it('rejects a trusted VERY-LOW-QUALITY post', () => {
    const lowQ = post({
      content: { text: 'this is some generic filler text that carries no real value at all here' },
      postClassification: classified({ spam: 0.1, quality: 0.1 }),
    });
    expect(passesLowEffortGate(lowQ, LOW_EFFORT_CFG)).toBe(false);
  });

  it('KEEPS an UNSCORED post with real prose (never empties on absent provenance)', () => {
    // Default all-zeros scores with no provenance marker → readTrustedScores null → kept.
    const unscored = post({
      content: { text: 'A perfectly ordinary sentence with actual words and meaning behind it.' },
      postClassification: { scores: { spam: 0, toxicity: 0, quality: 0, constructiveness: 0, controversy: 0, negativity: 0 } },
    });
    expect(passesLowEffortGate(unscored, LOW_EFFORT_CFG)).toBe(true);
  });

  it('KEEPS normal prose with good trusted scores', () => {
    const good = post({
      content: { text: 'Really enjoyed the new documentary about deep-sea exploration last night.' },
      postClassification: classified({ spam: 0.05, quality: 0.8 }),
    });
    expect(passesLowEffortGate(good, LOW_EFFORT_CFG)).toBe(true);
  });
});

// ─── nativeEngagementOrMatch branch behavior ─────────────────────────────────

describe('nativeEngagementOrMatch predicate', () => {
  it('passes a post with real NATIVE engagement (federated boosts excluded)', () => {
    const nativeTraction = post({
      stats: { likesCount: 2, commentsCount: 0, boostsCount: 0, federatedBoostsCount: 0 },
    });
    expect(passesNativeEngagementOrMatch(nativeTraction, EMPTY_CTX, NATIVE_CFG)).toBe(true);
  });

  it('does NOT count federated boosts toward the native floor', () => {
    // 5 boosts, all federated → 0 native → fails (off-interest, not fresh).
    const fedOnly = post({
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 5, federatedBoostsCount: 5 },
    });
    expect(passesNativeEngagementOrMatch(fedOnly, EMPTY_CTX, NATIVE_CFG)).toBe(false);

    // 5 boosts, 0 federated → 5 native → passes.
    const nativeBoosts = post({
      stats: { likesCount: 0, commentsCount: 0, boostsCount: 5, federatedBoostsCount: 0 },
    });
    expect(passesNativeEngagementOrMatch(nativeBoosts, EMPTY_CTX, NATIVE_CFG)).toBe(true);
  });

  it('passes a zero-engagement post that MATCHES a strong preferred topic', () => {
    const ctx: FeedEngineContext = {
      userBehavior: { preferredTopics: [{ topic: 'technology', weight: 0.8 }] },
    };
    const topical = post({ postClassification: { topics: ['technology'], languages: ['en'] } });
    expect(passesNativeEngagementOrMatch(topical, ctx, NATIVE_CFG)).toBe(true);
  });

  it('does NOT rescue via a WEAK preferred topic (below the weight floor)', () => {
    const ctx: FeedEngineContext = {
      userBehavior: { preferredTopics: [{ topic: 'technology', weight: 0.1 }] },
    };
    const topical = post({ postClassification: { topics: ['technology'] } });
    expect(passesNativeEngagementOrMatch(topical, ctx, NATIVE_CFG)).toBe(false);
  });

  it('passes a zero-engagement post from a PREFERRED author', () => {
    const ctx: FeedEngineContext = {
      userBehavior: { preferredAuthors: [{ authorId: 'author', weight: 0.9 }] },
    };
    expect(passesNativeEngagementOrMatch(post(), ctx, NATIVE_CFG)).toBe(true);
  });

  it('passes a FRESH zero-engagement post (cold-start supply)', () => {
    expect(passesNativeEngagementOrMatch(post({ createdAt: FRESH }), EMPTY_CTX, NATIVE_CFG)).toBe(true);
  });

  it('rejects a stale zero-engagement off-interest post', () => {
    expect(passesNativeEngagementOrMatch(post(), EMPTY_CTX, NATIVE_CFG)).toBe(false);
  });
});

describe('matchesViewerInterests', () => {
  it('is false for an anonymous / behavior-less viewer on a stale post', () => {
    expect(matchesViewerInterests(post(), EMPTY_CTX, NATIVE_CFG)).toBe(false);
  });

  it('matches on a strong topic, a preferred author, OR freshness', () => {
    const topicCtx: FeedEngineContext = { userBehavior: { preferredTopics: [{ topic: 'space', weight: 0.9 }] } };
    expect(matchesViewerInterests(post({ postClassification: { topics: ['space'] } }), topicCtx, NATIVE_CFG)).toBe(true);

    const authorCtx: FeedEngineContext = { userBehavior: { preferredAuthors: [{ authorId: 'author', weight: 0.9 }] } };
    expect(matchesViewerInterests(post(), authorCtx, NATIVE_CFG)).toBe(true);

    expect(matchesViewerInterests(post({ createdAt: FRESH }), EMPTY_CTX, NATIVE_CFG)).toBe(true);
  });
});

// ─── A good post survives the full gate ──────────────────────────────────────

describe('a personalized/legitimate post survives the full gate', () => {
  it('a topic-matched local post passes BOTH gate predicates', () => {
    const ctx: FeedEngineContext = {
      userBehavior: { preferredTopics: [{ topic: 'photography', weight: 0.7 }] },
    };
    const good = post({
      content: { text: 'Shot this at golden hour with a 50mm lens — really happy with the bokeh.' },
      postClassification: classified({ spam: 0.05, quality: 0.75 }, ['en']),
      // enrich with a matching topic
    });
    good.postClassification = {
      ...classified({ spam: 0.05, quality: 0.75 }, ['en']),
      topics: ['photography'],
    };
    expect(passesLowEffortGate(good, LOW_EFFORT_CFG)).toBe(true);
    expect(passesNativeEngagementOrMatch(good, ctx, NATIVE_CFG)).toBe(true);
  });
});
