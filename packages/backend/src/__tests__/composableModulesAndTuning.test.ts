import { describe, it, expect } from 'vitest';
import { MtnConfig, validateForYouTuning } from '@mention/shared-types';
import type { FeedTuning } from '@mention/shared-types';
import {
  minQualityFilter,
  noLowEffortFilter,
  linkCountFilter,
  noBotsFilter,
  lowEffortGateFilter,
  nativeEngagementFilter,
} from '../mtn/feed/engine/filters';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';
import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';

/**
 * PHASE 4B — user-composable quality/effort/link/bot filter modules + per-user
 * For You gate tuning (`feedTuning.forYou`). Asserts the thin wrappers keep/drop
 * correctly and that the gate reads EFFECTIVE per-viewer params (a viewer
 * disabling / re-tuning a gate module changes it for THAT viewer only, config
 * defaults intact for everyone else, fail-soft when no tuning).
 */

/** Trusted-provenance classification scores (baseline stamped at the current version). */
function classified(quality: number, spam = 0.05) {
  return {
    status: 'baseline' as const,
    version: BASELINE_CLASSIFIER_VERSION,
    scores: { spam, toxicity: 0, quality, constructiveness: 0.5, controversy: 0, negativity: 0 },
  };
}

function post(extra: Record<string, unknown> = {}): CandidatePost {
  return {
    _id: 'p',
    oxyUserId: 'author',
    createdAt: new Date(),
    stats: { likesCount: 0, commentsCount: 0, boostsCount: 0, federatedBoostsCount: 0 },
    ...extra,
  };
}

const EMPTY_CTX: FeedEngineContext = {};

// ─── minQuality ──────────────────────────────────────────────────────────────

describe('minQuality filter', () => {
  const keep = (p: CandidatePost, ctx: FeedEngineContext, params: Record<string, unknown>) =>
    minQualityFilter.keep!(p, ctx, params);

  it('drops a trusted post below the threshold and keeps one at/above it', () => {
    expect(keep(post({ postClassification: classified(0.3) }), EMPTY_CTX, { minQuality: 0.5 })).toBe(false);
    expect(keep(post({ postClassification: classified(0.8) }), EMPTY_CTX, { minQuality: 0.5 })).toBe(true);
    expect(keep(post({ postClassification: classified(0.5) }), EMPTY_CTX, { minQuality: 0.5 })).toBe(true);
  });

  it('is NEUTRAL when the post has no trusted score (never empties on absent provenance)', () => {
    // Default all-zeros scores with no provenance marker → readTrustedScores null → kept.
    const unscored = post({
      postClassification: { scores: { spam: 0, toxicity: 0, quality: 0, constructiveness: 0, controversy: 0, negativity: 0 } },
    });
    expect(keep(unscored, EMPTY_CTX, { minQuality: 0.5 })).toBe(true);
  });

  it('is NEUTRAL when no threshold is set', () => {
    expect(keep(post({ postClassification: classified(0.1) }), EMPTY_CTX, {})).toBe(true);
  });
});

// ─── noLowEffort ─────────────────────────────────────────────────────────────

describe('noLowEffort filter', () => {
  const keep = (p: CandidatePost, params: Record<string, unknown> = {}) =>
    noLowEffortFilter.keep!(p, EMPTY_CTX, params);

  it('drops custom-emoji shortcode-only and Unicode-emoji-only posts', () => {
    expect(keep(post({ content: { text: ':oyaki::oyaki: :blobcat:' } }))).toBe(false);
    expect(keep(post({ content: { text: '🔥🔥🚀✨' } }))).toBe(false);
  });

  it('keeps a low-effort post that carries media (media rescues it)', () => {
    expect(keep(post({ content: { text: '🔥🔥', media: [{ id: 'm', type: 'image' }] } }))).toBe(true);
  });

  it('keeps real prose', () => {
    expect(keep(post({ content: { text: 'A perfectly ordinary sentence with real words behind it.' } }))).toBe(true);
  });

  it('optionally drops emoji-HEAVY posts via maxEmojiRatio (and only then)', () => {
    const emojiHeavy = post({ content: { text: 'this is real text 🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥' } });
    // Without the ratio param the post has enough real text → kept.
    expect(keep(emojiHeavy)).toBe(true);
    // With a 0.5 ratio cap the emoji share exceeds it → dropped.
    expect(keep(emojiHeavy, { maxEmojiRatio: 0.5 })).toBe(false);
  });
});

// ─── linkCount ───────────────────────────────────────────────────────────────

describe('linkCount filter', () => {
  const keep = (p: CandidatePost, params: Record<string, unknown>) => linkCountFilter.keep!(p, EMPTY_CTX, params);
  const oneLink = post({ content: { text: 'see https://a.example' } });
  const twoLinks = post({ content: { text: 'https://a.example and https://b.example' } });

  it('enforces a minimum link count', () => {
    expect(keep(oneLink, { minLinks: 2 })).toBe(false);
    expect(keep(twoLinks, { minLinks: 2 })).toBe(true);
  });

  it('enforces a maximum link count', () => {
    expect(keep(twoLinks, { maxLinks: 1 })).toBe(false);
    expect(keep(oneLink, { maxLinks: 1 })).toBe(true);
  });

  it('is a no-op with neither bound set', () => {
    expect(keep(twoLinks, {})).toBe(true);
  });
});

// ─── noBots ──────────────────────────────────────────────────────────────────

describe('noBots filter', () => {
  const keep = (p: CandidatePost) => noBotsFilter.keep!(p, EMPTY_CTX, {});

  it('drops an RSS/bridge mirror actor (federated instance host)', () => {
    const mirror = post({
      content: { text: 'Some headline here' },
      federation: { actorUri: 'https://rss-mstdn.example/users/feed' },
    });
    expect(keep(mirror)).toBe(false);
  });

  it('drops a link-only news bot by TEXT SHAPE even without actor metadata', () => {
    const newsBot = post({
      content: { text: 'https://news.example/article-123' },
      hashtags: ['news', 'ゲーム', 'tech', 'update'],
    });
    expect(keep(newsBot)).toBe(false);
  });

  it('keeps a normal human post that merely embeds a link', () => {
    const human = post({
      content: { text: 'Really enjoyed this piece on deep-sea exploration, worth a read: https://blog.example/post' },
      federation: { actorUri: 'https://mastodon.social/users/alice' },
    });
    expect(keep(human)).toBe(true);
  });
});

// ─── For You gate tuning (feedTuning.forYou) ─────────────────────────────────

const GATE_PARAMS = { forYouGate: true } as const;

function tuning(forYou: FeedTuning['forYou']): FeedEngineContext {
  return { feedTuning: { forYou } };
}

describe('For You gate reads EFFECTIVE per-viewer params', () => {
  const emojiOnly = post({ content: { text: '🔥🔥🚀✨' } });

  it('fail-soft: with NO tuning the config-default gate applies (emoji-only rejected)', () => {
    expect(lowEffortGateFilter.keep!(emojiOnly, EMPTY_CTX, GATE_PARAMS)).toBe(false);
  });

  it('a viewer disabling lowEffortGate turns it off for THAT viewer only', () => {
    // Disabled for this viewer → kept.
    expect(lowEffortGateFilter.keep!(emojiOnly, tuning({ lowEffortGate: { enabled: false } }), GATE_PARAMS)).toBe(true);
    // A different viewer (no tuning) still gets the default gate → rejected.
    expect(lowEffortGateFilter.keep!(emojiOnly, EMPTY_CTX, GATE_PARAMS)).toBe(false);
  });

  it('a viewer can re-tune the nativeEngagement floor', () => {
    // A fresh post passes the default floor; raising minNativeEngagement past the
    // freshness grace does NOT change freshness rescue, so test the disable path.
    const stale = post({
      createdAt: new Date(Date.now() - MtnConfig.feed.discoveryGate.freshnessGraceMs - 60_000),
    });
    // Default gate: stale, zero-native, off-interest → rejected.
    expect(nativeEngagementFilter.keep!(stale, EMPTY_CTX, GATE_PARAMS)).toBe(false);
    // Disabled for this viewer → kept.
    expect(nativeEngagementFilter.keep!(stale, tuning({ nativeEngagement: { enabled: false } }), GATE_PARAMS)).toBe(true);
  });

  it('minQuality is NEUTRAL by default and only filters when the viewer opts in', () => {
    const lowQ = post({ postClassification: classified(0.2) });
    // Default (no tuning): neutral → kept.
    expect(minQualityFilter.keep!(lowQ, EMPTY_CTX, GATE_PARAMS)).toBe(true);
    // Viewer opts in with a threshold → low-quality dropped for them.
    expect(minQualityFilter.keep!(lowQ, tuning({ minQuality: { enabled: true, minQuality: 0.5 } }), GATE_PARAMS)).toBe(false);
    // Same viewer disabling it → back to neutral.
    expect(minQualityFilter.keep!(lowQ, tuning({ minQuality: { enabled: false, minQuality: 0.5 } }), GATE_PARAMS)).toBe(true);
  });

  it('For You tuning does NOT leak into a CUSTOM feed (no forYouGate marker)', () => {
    const lowQ = post({ postClassification: classified(0.2) });
    // Custom-feed usage: author sets minQuality param, NO forYouGate marker. A
    // viewer's feedTuning that disables minQuality must be ignored here.
    const ctx = tuning({ minQuality: { enabled: false } });
    expect(minQualityFilter.keep!(lowQ, ctx, { minQuality: 0.5 })).toBe(false);
  });
});

// ─── validateForYouTuning (shared) ───────────────────────────────────────────

describe('validateForYouTuning', () => {
  it('accepts a well-formed payload and normalizes to recognized values only', () => {
    const result = validateForYouTuning({
      lowEffortGate: { enabled: false },
      minQuality: { enabled: true, minQuality: 0.5 },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.lowEffortGate).toEqual({ enabled: false });
      expect(result.value.minQuality).toEqual({ enabled: true, minQuality: 0.5 });
    }
  });

  it('treats undefined / null as an empty tuning', () => {
    expect(validateForYouTuning(undefined)).toEqual({ valid: true, value: {} });
    expect(validateForYouTuning(null)).toEqual({ valid: true, value: {} });
  });

  it('rejects unknown modules, unknown params, bad types, and out-of-range thresholds', () => {
    expect(validateForYouTuning({ bogus: {} }).valid).toBe(false);
    expect(validateForYouTuning({ minQuality: { unknown: 1 } }).valid).toBe(false);
    expect(validateForYouTuning({ lowEffortGate: { enabled: 'yes' } }).valid).toBe(false);
    expect(validateForYouTuning({ minQuality: { minQuality: 2 } }).valid).toBe(false);
    expect(validateForYouTuning({ nativeEngagement: { minNativeEngagement: -1 } }).valid).toBe(false);
    expect(validateForYouTuning('nope').valid).toBe(false);
  });
});
