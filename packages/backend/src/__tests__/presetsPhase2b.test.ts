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

  it('defaults to the conservative Phase 2b subset when env is unset', () => {
    delete process.env.FOR_YOU_PHASE2B_SIGNALS;
    const ids = resolvePhase2bSignals().map((ref) => ref.module);
    expect(ids).toEqual(['penalizeSeen', 'dwellTime', 'mediaBoost', 'coldStartBoost']);
  });

  it('returns no opt-in signals when FOR_YOU_PHASE2B_SIGNALS=off', () => {
    process.env.FOR_YOU_PHASE2B_SIGNALS = 'off';
    expect(resolvePhase2bSignals()).toEqual([]);
  });

  it('accepts an explicit comma-separated subset', () => {
    process.env.FOR_YOU_PHASE2B_SIGNALS = 'penalizeSeen,mediaBoost';
    const ids = resolvePhase2bSignals().map((ref) => ref.module);
    expect(ids).toEqual(['penalizeSeen', 'mediaBoost']);
  });

  it('drops unknown signal ids from the env list', () => {
    process.env.FOR_YOU_PHASE2B_SIGNALS = 'penalizeSeen,notASignal,dwellTime';
    const ids = resolvePhase2bSignals().map((ref) => ref.module);
    expect(ids).toEqual(['penalizeSeen', 'dwellTime']);
  });
});

describe('preset definitions include Phase 2b signals', () => {
  it('forYouDefinition signals include the default Phase 2b subset at module load', () => {
    const ids = forYouDefinition.signals.map((ref) => ref.module);
    expect(ids).toContain('penalizeSeen');
    expect(ids).toContain('dwellTime');
    expect(ids).toContain('mediaBoost');
    expect(ids).toContain('coldStartBoost');
    expect(forYouDefinition.signals.length).toBeGreaterThanOrEqual(BASE_SIGNAL_COUNT + 4);
  });

  it('videosDefinition signals include the same Phase 2b modules as forYou', () => {
    const forYouIds = forYouDefinition.signals.map((ref) => ref.module);
    const videoIds = videosDefinition.signals.map((ref) => ref.module);
    expect(videoIds).toEqual(forYouIds);
  });
});
