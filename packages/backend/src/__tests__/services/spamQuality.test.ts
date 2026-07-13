import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import {
  computeDeterministicScores,
  SPAM_QUALITY_CONFIG,
  type DeterministicScores,
  type ScoreContext,
} from '../../services/contentClassification/spamQuality';

/**
 * Unit tests for the deterministic spam/quality/toxicity heuristics. All inputs
 * are crafted to exercise a single signal at a time so the assertions stay
 * robust to constant tuning (they compare against the configured thresholds, not
 * hardcoded score values).
 */

/** Convenience: score `text` with an explicit canonical hashtag count. */
function score(text: string, hashtagCount = 0): DeterministicScores {
  return computeDeterministicScores(text, hashtagCount);
}

describe('computeDeterministicScores — bounds & shape', () => {
  it('always returns finite 0..1 scores', () => {
    const samples = [
      '',
      'hello world',
      '#a #b #c #d #e #f #g #h #i #j',
      'BUY NOW!!!!!!!!!! https://x.com https://y.com https://z.com',
      'a'.repeat(500),
    ];
    for (const text of samples) {
      const s = score(text, 6);
      for (const value of [s.spam, s.quality, s.toxicity]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('treats empty / undefined text without throwing', () => {
    expect(() => computeDeterministicScores('', 0)).not.toThrow();
    // @ts-expect-error — defensive: callers always pass a string, but guard anyway.
    expect(() => computeDeterministicScores(undefined, 0)).not.toThrow();
  });
});

describe('SPAM detection', () => {
  it('flags excessive hashtags as high spam', () => {
    const cfg = SPAM_QUALITY_CONFIG.spam;
    // Well over the threshold → near the hashtag cap.
    const text = '#one #two #three #four #five #six #seven #eight #nine #ten';
    const hashtagCount = 10;
    const { spam } = score(text, hashtagCount);
    expect(spam).toBeGreaterThanOrEqual(cfg.hashtagMax - 1e-9);
  });

  it('flags excessive links as high spam', () => {
    const cfg = SPAM_QUALITY_CONFIG.spam;
    const text =
      'Some real words here to avoid the link-only path entirely, just sharing links: ' +
      'https://a.example https://b.example https://c.example https://d.example';
    const { spam } = score(text, 0);
    expect(spam).toBeGreaterThanOrEqual(cfg.linkMax - 1e-9);
  });

  it('flags an all-caps shouting post as spammy', () => {
    const text = 'THIS IS A COMPLETELY SHOUTED MESSAGE WITH NO LOWERCASE AT ALL';
    const { spam } = score(text, 0);
    expect(spam).toBeGreaterThanOrEqual(SPAM_QUALITY_CONFIG.spam.capsWeight - 1e-9);
  });

  it('does NOT flag a short all-caps token (too few letters)', () => {
    // "OK" / "WOW" are below capsMinLetters — must not be marked spammy.
    expect(score('OK', 0).spam).toBe(0);
    expect(score('WOW nice', 0).spam).toBe(0);
  });

  it('flags repeated-character flooding', () => {
    const text = 'so goooooooooood right';
    const { spam } = score(text, 0);
    expect(spam).toBeGreaterThanOrEqual(SPAM_QUALITY_CONFIG.spam.repeatWeight - 1e-9);
  });

  it('flags a link-only post', () => {
    const { spam } = score('https://promo.example/deal', 0);
    expect(spam).toBeGreaterThanOrEqual(SPAM_QUALITY_CONFIG.spam.linkOnlyWeight - 1e-9);
  });

  it('flags excessive @-mentions', () => {
    const cfg = SPAM_QUALITY_CONFIG.spam;
    const text = 'hey @a @b @c @d @e @f check this out together';
    const { spam } = score(text, 0);
    expect(spam).toBeGreaterThan(0);
    expect(spam).toBeLessThanOrEqual(1);
    // At/over the mention threshold contributes something measurable.
    expect(spam).toBeGreaterThanOrEqual(cfg.mentionStep - 1e-9);
  });

  it('flags a short promotional post with a link', () => {
    const { spam } = score('Buy now, limited offer! https://shop.example/x', 0);
    expect(spam).toBeGreaterThanOrEqual(SPAM_QUALITY_CONFIG.spam.promoWeight - 1e-9);
  });

  it('scores a normal conversational post as NOT spam', () => {
    const text = 'Had a great walk this morning and the weather was perfect for it.';
    expect(score(text, 0).spam).toBe(0);
  });

  it('combines multiple spam signals (hashtag dump + links + caps) toward the cap', () => {
    const text =
      'BUY NOW!!! #deal #deal2 #deal3 #deal4 #deal5 #deal6 https://a.x https://b.x https://c.x';
    const { spam } = score(text, 6);
    // Multiple signals combine and clamp at 1.
    expect(spam).toBeGreaterThan(SPAM_QUALITY_CONFIG.spam.hashtagMax);
    expect(spam).toBeLessThanOrEqual(1);
  });
});

describe('QUALITY heuristic', () => {
  it('scores substantive text with sentence structure as high quality', () => {
    const text =
      'I finally finished migrating the service to the new runtime. ' +
      'The latency dropped noticeably and the error rate is way down. ' +
      'Really happy with how the rollout went today!';
    const { quality } = score(text, 0);
    expect(quality).toBeGreaterThan(SPAM_QUALITY_CONFIG.quality.base);
  });

  it('scores a very short post as low quality', () => {
    const { quality } = score('lol', 0);
    expect(quality).toBeLessThan(SPAM_QUALITY_CONFIG.quality.base);
  });

  it('scores a link-only post as low quality', () => {
    const { quality } = score('https://x.example/thing', 0);
    expect(quality).toBeLessThan(SPAM_QUALITY_CONFIG.quality.base);
  });

  it('scores an all-emoji post as low quality (no letters)', () => {
    const { quality } = score('🔥🔥🔥🚀🚀', 0);
    expect(quality).toBeLessThan(SPAM_QUALITY_CONFIG.quality.base);
  });

  it('scores a pure hashtag dump as low quality', () => {
    const text = '#one #two #three #four #five #six';
    const { quality } = score(text, 6);
    expect(quality).toBeLessThan(SPAM_QUALITY_CONFIG.quality.base);
  });

  it('couples quality DOWN with high spam (a spammy post is also low quality)', () => {
    // Long-but-spammy: substantial length boost is offset by the spam coupling.
    const spammy =
      'AMAZING DEAL DO NOT MISS THIS LIMITED OFFER BUY NOW BUY NOW BUY NOW ' +
      'https://a.x https://b.x https://c.x https://d.x';
    const clean =
      'Amazing deal do not miss this, a thoughtful write-up about the launch ' +
      'with real detail and a clear conclusion that wraps things up nicely.';
    expect(score(spammy, 0).quality).toBeLessThan(score(clean, 0).quality);
  });
});

describe('TOXICITY heuristic', () => {
  it('returns 0 for clean text', () => {
    expect(score('what a lovely and kind community this is', 0).toxicity).toBe(0);
  });

  it('flags a post containing profanity', () => {
    const { toxicity } = score('this is absolute shit and i hate it', 0);
    expect(toxicity).toBeGreaterThan(0);
    expect(toxicity).toBeLessThanOrEqual(SPAM_QUALITY_CONFIG.toxicity.max);
  });

  it('escalates toxicity with multiple distinct profane terms', () => {
    const one = score('what the fuck', 0).toxicity;
    const two = score('what the fuck you bitch', 0).toxicity;
    expect(two).toBeGreaterThan(one);
  });

  it('uses whole-word matching (no substring false positives)', () => {
    // "Scunthorpe problem": substrings must NOT trigger profanity.
    expect(score('I love the classics and assets management', 0).toxicity).toBe(0);
  });

  it('caps toxicity at the configured maximum', () => {
    const { toxicity } = score('fuck shit bitch cunt asshole bastard whore slut', 0);
    expect(toxicity).toBeLessThanOrEqual(SPAM_QUALITY_CONFIG.toxicity.max);
  });
});

describe('determinism & purity', () => {
  it('is deterministic for the same input', () => {
    const text = 'BUY NOW #deal #deal2 https://x.example shit';
    expect(score(text, 2)).toEqual(score(text, 2));
  });
});

describe('v5 low-effort + bot hardening', () => {
  const SAFETY_SPAM_THRESHOLD = MtnConfig.ranking.aiQuality.safety.spamThreshold; // 0.7
  const QUALITY_LOW_THRESHOLD = MtnConfig.ranking.aiQuality.quality.lowThreshold; // 0.3

  it('flags a custom-emoji shortcode-only post: high spam + quality below the low threshold', () => {
    const { spam, quality } = score(':oyaki::oyaki::oyaki:', 0);
    expect(spam).toBeGreaterThanOrEqual(
      SPAM_QUALITY_CONFIG.lowEffort.noRealTextSpamWeight +
        SPAM_QUALITY_CONFIG.lowEffort.shortcodeOnlySpamWeight -
        1e-9,
    );
    expect(quality).toBeLessThan(QUALITY_LOW_THRESHOLD);
  });

  it('clears the ranking safety spam threshold for an RSS Service actor + link + hashtag tail', () => {
    const context: ScoreContext = {
      actorType: 'Service',
      instanceDomain: 'rss-mstdn.example',
      isFederated: true,
    };
    const { spam } = computeDeterministicScores(
      'https://news.example/article #news #breaking #world #politics',
      4,
      context,
    );
    expect(spam).toBeGreaterThanOrEqual(SAFETY_SPAM_THRESHOLD);
  });

  it('does NOT penalize normal German prose (regression guard): spam stays 0, quality stays high', () => {
    const german =
      'Heute war ein wirklich schöner Tag im Park. Die Sonne schien und ich habe ' +
      'ein gutes Buch gelesen. Am Abend habe ich noch lange mit Freunden geredet.';
    const result = score(german, 0);
    expect(result.spam).toBe(0);
    expect(result.quality).toBeGreaterThan(SPAM_QUALITY_CONFIG.quality.base);
    // A federated Person on a normal instance yields the SAME scores — off-language
    // real prose is a ranking concern, never a classification penalty.
    expect(
      computeDeterministicScores(german, 0, {
        actorType: 'Person',
        instanceDomain: 'chaos.social',
        isFederated: true,
      }),
    ).toEqual(result);
  });

  it('is byte-identical for a clean post whether or not a context is supplied', () => {
    const text =
      'I finally shipped the feature I was working on all week. Really proud of how it turned out!';
    const withoutContext = computeDeterministicScores(text, 0);
    expect(computeDeterministicScores(text, 0, undefined)).toEqual(withoutContext);
    expect(computeDeterministicScores(text, 0, {})).toEqual(withoutContext);
    expect(computeDeterministicScores(text, 0, { isFederated: false })).toEqual(withoutContext);
  });
});
