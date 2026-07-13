import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { CachedUserSummary } from '../services/userSummaryCache';

/**
 * PHASE 4c/4b resolution helpers.
 *
 * `loadViewerLanguages` resolves the VIEWER's Oxy account languages (canonical
 * BCP-47 locales, primary first) for the `languageMismatchPenalty` ranking
 * signal, reusing the Redis-cached identity path the feed already uses for post
 * authors — so it adds no new Oxy round trip and soft-fails to `[]` (neutral
 * penalty) on any miss or error. `resolveDiscoveryGate` maps the
 * `FOR_YOU_DISCOVERY_GATE` env flag onto the For You discovery-gate filter set.
 */

const { resolveUserSummaries } = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

// The identity path `loadViewerLanguages` reuses. Mocked so this suite asserts
// the CONTRACT (cached locales in, fail-soft out) without Redis or Oxy — and so
// importing feedContext stays free of the hydration module's dependency chain.
vi.mock('../services/PostHydrationService', () => ({ resolveUserSummaries }));

import { loadViewerLanguages } from '../mtn/feed/feedContext';
import { resolveDiscoveryGate } from '../mtn/feed/definitions/presets';

/** A cached identity carrying the account's canonical locales. */
function summaryWith(userId: string, languages?: string[]): CachedUserSummary {
  return {
    user: { id: userId, username: 'viewer', name: { displayName: 'Viewer' } },
    languages,
  };
}

describe('loadViewerLanguages', () => {
  const viewerId = 'viewer-1';

  beforeEach(() => {
    resolveUserSummaries.mockReset();
  });

  it('returns the viewer\'s account locales, primary first', async () => {
    resolveUserSummaries.mockResolvedValue(
      new Map([[viewerId, summaryWith(viewerId, ['es-ES', 'en-US'])]]),
    );

    await expect(loadViewerLanguages(viewerId)).resolves.toEqual(['es-ES', 'en-US']);
    expect(resolveUserSummaries).toHaveBeenCalledWith([viewerId]);
  });

  it('returns [] for an anonymous viewer WITHOUT touching the identity path', async () => {
    await expect(loadViewerLanguages(undefined)).resolves.toEqual([]);
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('returns [] when the account declares no languages', async () => {
    resolveUserSummaries.mockResolvedValue(new Map([[viewerId, summaryWith(viewerId)]]));
    await expect(loadViewerLanguages(viewerId)).resolves.toEqual([]);
  });

  it('returns [] when the viewer cannot be resolved', async () => {
    resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());
    await expect(loadViewerLanguages(viewerId)).resolves.toEqual([]);
  });

  it('is FAIL-SOFT: a lookup error degrades to [] (neutral penalty), never throws', async () => {
    resolveUserSummaries.mockRejectedValue(new Error('oxy unreachable'));
    await expect(loadViewerLanguages(viewerId)).resolves.toEqual([]);
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
