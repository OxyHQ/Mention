import { describe, it, expect, afterEach } from 'vitest';
import { resolveViewerLanguages } from '../mtn/feed/feedContext';
import { resolveDiscoveryGate } from '../mtn/feed/definitions/presets';

/**
 * PHASE 4c/4b resolution helpers.
 *
 * `resolveViewerLanguages` is the UPSTREAM-READY reader for the (not-yet-exposed)
 * Oxy account `languages` field; `resolveDiscoveryGate` maps the
 * `FOR_YOU_DISCOVERY_GATE` env flag onto the For You discovery-gate filter set.
 */

describe('resolveViewerLanguages', () => {
  it('returns [] when the field is absent / not an array', () => {
    expect(resolveViewerLanguages(undefined)).toEqual([]);
    expect(resolveViewerLanguages(null)).toEqual([]);
    expect(resolveViewerLanguages({})).toEqual([]);
    expect(resolveViewerLanguages({ languages: 'en' })).toEqual([]);
  });

  it('normalizes (lowercases, trims), dedupes, and drops non-strings', () => {
    expect(resolveViewerLanguages({ languages: ['EN', ' es ', 'en', 42, null, ''] })).toEqual(['en', 'es']);
  });
});

describe('resolveDiscoveryGate', () => {
  const original = process.env.FOR_YOU_DISCOVERY_GATE;
  afterEach(() => {
    if (original === undefined) delete process.env.FOR_YOU_DISCOVERY_GATE;
    else process.env.FOR_YOU_DISCOVERY_GATE = original;
  });

  const ids = (refs: ReturnType<typeof resolveDiscoveryGate>) => refs.map((r) => r.module);

  it('defaults to the full gate when unset', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    // Phase 4B adds `minQuality` — NEUTRAL by default (opt-in via feedTuning), so
    // it changes nothing unless a viewer sets a threshold in For You settings.
    expect(ids(resolveDiscoveryGate())).toEqual(['minLength', 'lowEffortGate', 'nativeEngagement', 'minQuality']);
  });

  it('stamps the `forYouGate` marker on every gate ref', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    expect(resolveDiscoveryGate().every((r) => r.params?.forYouGate === true)).toBe(true);
  });

  it('is empty when explicitly off', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'off';
    expect(resolveDiscoveryGate()).toEqual([]);
  });

  it('accepts an explicit subset', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'lowEffortGate,nativeEngagement,bogus';
    expect(ids(resolveDiscoveryGate())).toEqual(['lowEffortGate', 'nativeEngagement']);
  });

  it('injects the minLength threshold from config', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    const minLength = resolveDiscoveryGate().find((r) => r.module === 'minLength');
    expect(minLength?.params?.minLength).toBeTypeOf('number');
  });
});
