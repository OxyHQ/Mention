import { afterEach, describe, expect, it } from 'vitest';

import {
  forYouDefinition,
  resolvePhase2bSignals,
  videosDefinition,
} from '../mtn/feed/definitions/presets';

const BASE_SIGNAL_COUNT = 9;

describe('resolvePhase2bSignals', () => {
  const original = process.env.FOR_YOU_PHASE2B_SIGNALS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.FOR_YOU_PHASE2B_SIGNALS;
    } else {
      process.env.FOR_YOU_PHASE2B_SIGNALS = original;
    }
  });

  it('defaults to the Phase 5 subset when env is unset', () => {
    delete process.env.FOR_YOU_PHASE2B_SIGNALS;
    const ids = resolvePhase2bSignals().map((ref) => ref.module);
    expect(ids).toEqual([
      'penalizeSeen',
      'coldStartBoost',
      'socialProof',
      'noveltyBoost',
      'verifiedBoost',
      'localBoost',
      'languageMismatchPenalty',
      'starterPackBoost',
    ]);
  });

  it('returns no opt-in signals when FOR_YOU_PHASE2B_SIGNALS=off', () => {
    process.env.FOR_YOU_PHASE2B_SIGNALS = 'off';
    expect(resolvePhase2bSignals()).toEqual([]);
  });

  it('accepts an explicit comma-separated subset (incl. optional signals)', () => {
    process.env.FOR_YOU_PHASE2B_SIGNALS = 'penalizeSeen,mediaBoost,dwellTime';
    const ids = resolvePhase2bSignals().map((ref) => ref.module);
    expect(ids).toEqual(['penalizeSeen', 'mediaBoost', 'dwellTime']);
  });

  it('rejects unknown signal ids instead of silently dropping them', () => {
    process.env.FOR_YOU_PHASE2B_SIGNALS = 'socialProof,notASignal,verifiedBoost';
    expect(() => resolvePhase2bSignals()).toThrow('FOR_YOU_PHASE2B_SIGNALS');
  });
});

describe('preset definitions include Phase 2b signals', () => {
  it('forYouDefinition signals include the Phase 5 default subset at module load', () => {
    const ids = forYouDefinition.signals.map((ref) => ref.module);
    expect(ids).toContain('penalizeSeen');
    expect(ids).toContain('coldStartBoost');
    expect(ids).toContain('socialProof');
    expect(ids).toContain('noveltyBoost');
    expect(ids).toContain('verifiedBoost');
    expect(ids).toContain('localBoost');
    expect(ids).toContain('languageMismatchPenalty');
    expect(ids).toContain('starterPackBoost');
    // `mediaBoost` / `dwellTime` are OPTIONAL — never in the default set.
    expect(ids).not.toContain('mediaBoost');
    expect(ids).not.toContain('dwellTime');
    expect(forYouDefinition.signals.length).toBeGreaterThanOrEqual(BASE_SIGNAL_COUNT + 8);
  });

  /**
   * Videos carries the SAME shared set as For You, plus exactly one signal of its
   * own. Asserted as "For You's set, then `portraitBoost`" rather than as set
   * equality, so a Phase 2b module that stops reaching Videos still goes red —
   * the property this guards — while the one deliberate difference is named.
   *
   * `portraitBoost` is Videos-only because the reels screen is full-screen. It is
   * a signal rather than a sort key: an absolute portrait-first sort broke the
   * prefix invariant `FeedEngine.finalizeRanked`'s score cursor pages on, and
   * could drop landscape videos from every page.
   */
  it('videosDefinition signals are forYou\'s, plus portraitBoost', () => {
    const forYouIds = forYouDefinition.signals.map((ref) => ref.module);
    const videoIds = videosDefinition.signals.map((ref) => ref.module);
    expect(videoIds).toEqual([...forYouIds, 'portraitBoost']);
  });
});
