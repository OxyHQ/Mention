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

  it('drops unknown signal ids from the env list', () => {
    process.env.FOR_YOU_PHASE2B_SIGNALS = 'socialProof,notASignal,verifiedBoost';
    const ids = resolvePhase2bSignals().map((ref) => ref.module);
    expect(ids).toEqual(['socialProof', 'verifiedBoost']);
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
    // `mediaBoost` / `dwellTime` are OPTIONAL — never in the default set.
    expect(ids).not.toContain('mediaBoost');
    expect(ids).not.toContain('dwellTime');
    expect(forYouDefinition.signals.length).toBeGreaterThanOrEqual(BASE_SIGNAL_COUNT + 7);
  });

  it('videosDefinition signals include the same Phase 2b modules as forYou', () => {
    const forYouIds = forYouDefinition.signals.map((ref) => ref.module);
    const videoIds = videosDefinition.signals.map((ref) => ref.module);
    expect(videoIds).toEqual(forYouIds);
  });
});
