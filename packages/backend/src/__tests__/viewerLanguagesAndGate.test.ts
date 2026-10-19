import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { OxyClient } from '../utils/privacyHelpers';
import { createMemoryCache } from './helpers/memoryCache';

const { cacheStore } = vi.hoisted(() => ({ cacheStore: new Map<string, unknown>() }));

// The suite has no Redis; give the viewer-languages cache a memory store so a hit
// is observable. Every other cache keeps the real (Redis-less) implementation.
vi.mock('../utils/cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/cache')>();
  return {
    ...actual,
    createCache: (config: Parameters<typeof actual.createCache>[0]) =>
      config.name === 'ViewerLanguagesCache'
        ? createMemoryCache(cacheStore)
        : actual.createCache(config),
  };
});

import { resolveViewerBaseLanguages } from '../mtn/feed/feedContext';
import { resolveDiscoveryGate } from '../mtn/feed/definitions/presets';
import {
  invalidateViewerLanguages,
  languageLadder,
  loadViewerLanguages,
  requestLanguageCandidates,
} from '../utils/viewerLanguage';

describe('loadViewerLanguages', () => {
  const viewerId = 'viewer-1';
  const me = vi.fn();
  const client: OxyClient = {
    users: { me },
    privacy: { blocked: vi.fn(), restricted: vi.fn() },
    follows: { following: vi.fn(), followers: vi.fn(), viewerGraph: vi.fn() },
  };
  beforeEach(() => {
    me.mockReset();
    cacheStore.clear();
  });

  it('serves a warm viewer from the cache until a profile write invalidates it', async () => {
    me.mockResolvedValue({ id: viewerId, languages: ['es-ES', 'en-US', 'ca-ES'] });
    await loadViewerLanguages(viewerId, client);
    await expect(loadViewerLanguages(viewerId, client)).resolves.toEqual([
      'es-ES',
      'en-US',
      'ca-ES',
    ]);
    expect(me).toHaveBeenCalledOnce();

    // The reader reorders in Oxy; the broadcast evicts their entry.
    me.mockResolvedValue({ id: viewerId, languages: ['ca-ES', 'es-ES', 'en-US'] });
    await invalidateViewerLanguages([viewerId]);
    await expect(loadViewerLanguages(viewerId, client)).resolves.toEqual([
      'ca-ES',
      'es-ES',
      'en-US',
    ]);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it('reads every ordered account locale from the authenticated owner profile', async () => {
    me.mockResolvedValue({ id: viewerId, languages: ['es-ES', 'en-US', 'ca-ES', 'fr-FR'] });
    await expect(loadViewerLanguages(viewerId, client)).resolves.toEqual([
      'es-ES',
      'en-US',
      'ca-ES',
      'fr-FR',
    ]);
    expect(me).toHaveBeenCalledOnce();
  });

  it('does not fetch an owner profile for an anonymous reader', async () => {
    await expect(loadViewerLanguages(undefined, client)).resolves.toEqual([]);
    expect(me).not.toHaveBeenCalled();
  });

  it('does not use another account’s languages', async () => {
    me.mockResolvedValue({ id: 'other', languages: ['de-DE'] });
    await expect(loadViewerLanguages(viewerId, client)).resolves.toEqual([]);
  });

  it('returns no preference when the account has none', async () => {
    me.mockResolvedValue({ id: viewerId });
    await expect(loadViewerLanguages(viewerId, client)).resolves.toEqual([]);
  });

  it('supports delegated requests without an owner-profile capability', async () => {
    await expect(loadViewerLanguages(viewerId)).resolves.toEqual([]);
  });

  it('falls back on an Oxy failure', async () => {
    me.mockRejectedValue(new Error('oxy unreachable'));
    await expect(loadViewerLanguages(viewerId, client)).resolves.toEqual([]);
  });
});

/**
 * The reader's READABILITY set — which languages they can read at all.
 *
 * Separate from `loadViewerLanguages` on purpose, and the separation is
 * load-bearing rather than cosmetic. `loadViewerLanguages` answers "which
 * RENDITION of this post do I show?", which hydration resolves through
 * `selectVariantForTag` — that matches the EXACT locale before the base subtag,
 * so `pt-BR` and `pt-PT` are genuinely different answers and the region must
 * survive. This answers "can this reader read this post AT ALL?", where the
 * region is noise and must not cause a false mismatch.
 *
 * This is also the single place garbage is dropped, which is why the ranking
 * signals downstream trust their input and do not re-normalize it.
 */
describe('resolveViewerBaseLanguages', () => {
  it('reduces account locales to their base subtag, order preserved', () => {
    expect(resolveViewerBaseLanguages(['es-ES', 'en-US'], [])).toEqual(['es', 'en']);
  });

  it('falls back to the REQUEST when the account declares nothing', () => {
    expect(resolveViewerBaseLanguages([], ['es-ES', 'en'])).toEqual(['es', 'en']);
  });

  /**
   * The anonymous case, which is the one the whole change exists for: a
   * signed-out reader has no account, so the request is their only declaration.
   * Before this, `viewerLanguages` was `[]` for every logged-out reader and every
   * language-conditional path went neutral — measured on production, that feed
   * came back 48% `de` against a 6.8%-`de` corpus.
   */
  it('resolves an anonymous reader from the request alone', () => {
    expect(resolveViewerBaseLanguages([], ['de-DE'])).toEqual(['de']);
  });

  it('prefers the ACCOUNT over the request when both are present', () => {
    expect(resolveViewerBaseLanguages(['es-ES'], ['de-DE'])).toEqual(['es']);
  });

  it('de-duplicates locales that share a base subtag', () => {
    expect(resolveViewerBaseLanguages(['es-ES', 'es-MX', 'en-GB'], [])).toEqual(['es', 'en']);
  });

  /**
   * `Accept-Language` is attacker-controlled and unbounded. The cap bounds two
   * things at once: the width of the `&&` array overlap on every discovery lane,
   * and the cardinality of the anonymous feed cache, whose key now carries this
   * set.
   */
  it('preserves every Oxy account language, even beyond the request cap', () => {
    expect(resolveViewerBaseLanguages(['es-ES', 'en-US', 'ca-ES', 'fr-FR'], ['de'])).toEqual([
      'es',
      'en',
      'ca',
      'fr',
    ]);
  });

  it('caps request languages at three', () => {
    expect(resolveViewerBaseLanguages([], ['es', 'en', 'de', 'fr', 'ja'])).toEqual([
      'es',
      'en',
      'de',
    ]);
  });

  /**
   * Garbage drops out HERE, so no consumer has to defend against it. An entry
   * that survived would not merely be ignored — it would fail to match every
   * post, which for a hard SQL predicate means an empty feed.
   */
  it('drops unparseable entries rather than passing them through', () => {
    expect(resolveViewerBaseLanguages([], ['', '   ', 'not-a-language-tag'])).toEqual([]);
    expect(resolveViewerBaseLanguages([], ['', 'es-ES'])).toEqual(['es']);
  });

  it('is [] when neither side declares anything (an UNKNOWN reader, never a filtered one)', () => {
    expect(resolveViewerBaseLanguages([], [])).toEqual([]);
  });
});

/**
 * Which rendition a reader is SERVED. A device default (`Accept-Language`) must
 * not outrank what a signed-in reader declared on their Oxy account: a Catalan
 * browser on a Spanish-primary account reads Spanish. Only an explicit `?lang`
 * outranks the account.
 */
describe('languageLadder', () => {
  const request = (lang?: string) =>
    requestLanguageCandidates({
      query: lang ? { lang } : {},
      acceptsLanguages: () => ['ca-ES', 'es-ES'],
    } as never);

  it('orders ?lang, then the account locales, then Accept-Language', () => {
    expect(languageLadder(request(), ['es-ES', 'ca-ES'])).toEqual(['es-ES', 'ca-ES']);
    expect(languageLadder(request('en'), ['es-ES'])).toEqual(['en', 'es-ES', 'ca-ES']);
    expect(languageLadder(request(), [])).toEqual(['ca-ES', 'es-ES']);
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
    // `noContentWarning` is the recommendation-hygiene rule, ON by default and
    // scoped by its own followed-author exemption rather than by this list.
    expect(ids(resolveDiscoveryGate())).toEqual([
      'minLength',
      'lowEffortGate',
      'nativeEngagement',
      'minQuality',
      'noContentWarning',
    ]);
  });

  it('stamps the `viewerGateTuning` marker on every gate ref', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    expect(resolveDiscoveryGate().every((r) => r.params?.viewerGateTuning === true)).toBe(true);
  });

  it('is empty when explicitly off', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'off';
    expect(resolveDiscoveryGate()).toEqual([]);
  });

  it('accepts a validated explicit subset', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'lowEffortGate,nativeEngagement';
    expect(ids(resolveDiscoveryGate())).toEqual(['lowEffortGate', 'nativeEngagement']);
  });

  it('rejects unknown gate ids instead of silently dropping them', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'lowEffortGate,bogus';
    expect(() => resolveDiscoveryGate()).toThrow('FOR_YOU_DISCOVERY_GATE');
  });

  it('injects the minLength threshold from config', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    const minLength = resolveDiscoveryGate().find((r) => r.module === 'minLength');
    expect(minLength?.params?.minLength).toBeTypeOf('number');
  });
});
