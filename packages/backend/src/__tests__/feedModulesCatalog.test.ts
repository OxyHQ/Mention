import { beforeAll, describe, it, expect } from 'vitest';

/**
 * Task 5 — the module catalog offers only userComposable sources/filters + every
 * ranking signal, grouped by kind, each with i18n keys + a params schema. GET
 * /feed/modules returns it read-only.
 */

import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { registerAllModules, feedModuleRegistry } from '../mtn/feed/engine';
import { buildModuleCatalog } from '../mtn/feed/moduleCatalog';
import { feedModulesController } from '../mtn/controllers/feedModules.controller';

const registry = new FeedModuleRegistry();

beforeAll(() => {
  registerAllModules(registry);
  registerAllModules(feedModuleRegistry); // populate the shared singleton for the controller test
});

describe('buildModuleCatalog', () => {
  it('includes userComposable sources and excludes viewer-relative ones', () => {
    const catalog = buildModuleCatalog(registry);
    const sourceIds = catalog.sources.map((s) => s.id);
    expect(sourceIds).toContain('keywords');
    expect(sourceIds).toContain('accounts');
    expect(sourceIds).toContain('trending');
    expect(sourceIds).not.toContain('following');
    expect(sourceIds).not.toContain('authored');
    expect(sourceIds).not.toContain('mutuals');
  });

  it('includes the Phase 4 userComposable related sources', () => {
    const catalog = buildModuleCatalog(registry);
    const sourceIds = catalog.sources.map((s) => s.id);
    expect(sourceIds).toContain('moreLikeThis');
    expect(sourceIds).toContain('nearby');
    expect(sourceIds).toContain('risingCreators');

    const moreLikeThis = catalog.sources.find((s) => s.id === 'moreLikeThis');
    expect(moreLikeThis?.paramsSchema.properties.topics?.maxItems).toBe(20);
    const nearby = catalog.sources.find((s) => s.id === 'nearby');
    expect(nearby?.paramsSchema.properties.lat).toEqual({ type: 'number' });
    const rising = catalog.sources.find((s) => s.id === 'risingCreators');
    expect(rising?.paramsSchema.properties).toEqual({});
  });

  it('includes userComposable filters and excludes internal ones', () => {
    const catalog = buildModuleCatalog(registry);
    const filterIds = catalog.filters.map((f) => f.id);
    expect(filterIds).toContain('noReplies');
    expect(filterIds).toContain('languagePreference');
    expect(filterIds).toContain('muteBlock');
    expect(filterIds).not.toContain('safety');
    expect(filterIds).not.toContain('dedupe');
  });

  it('includes every ranking signal', () => {
    const catalog = buildModuleCatalog(registry);
    const signalIds = catalog.signals.map((s) => s.id);
    expect(signalIds).toContain('engagement');
    expect(signalIds).toContain('recency');
  });

  it('includes the Phase 2b opt-in signals (builder-composable for custom feeds)', () => {
    const catalog = buildModuleCatalog(registry);
    const signalIds = catalog.signals.map((s) => s.id);
    for (const id of [
      'mediaBoost',
      'positivity',
      'conversational',
      'coldStartBoost',
      'penalizeSeen',
      'verifiedBoost',
      'dwellTime',
      'socialProof',
      'reciprocityBoost',
      'noveltyBoost',
    ]) {
      expect(signalIds).toContain(id);
    }
  });

  it('annotates each entry with i18n keys + a params schema', () => {
    const catalog = buildModuleCatalog(registry);
    const keywords = catalog.sources.find((s) => s.id === 'keywords');
    expect(keywords).toBeDefined();
    expect(keywords!.labelKey).toBe('feeds.modules.keywords.label');
    expect(keywords!.descriptionKey).toBe('feeds.modules.keywords.description');
    expect(keywords!.kind).toBe('source');
    expect(keywords!.paramsSchema.properties.keywords).toEqual({ type: 'array', items: { type: 'string' }, maxItems: 50 });
    expect(keywords!.paramsSchema.properties.hashtags?.maxItems).toBe(50);

    const accounts = catalog.sources.find((s) => s.id === 'accounts');
    expect(accounts!.paramsSchema.properties.authorIds?.maxItems).toBe(200);

    const trending = catalog.sources.find((s) => s.id === 'trending');
    expect(trending!.paramsSchema.properties).toEqual({});
  });
});

describe('GET /feed/modules (controller)', () => {
  it('returns the grouped catalog', async () => {
    let status = 0;
    let body: unknown;
    const res = {
      status(c: number) { status = c; return this; },
      json(b: unknown) { body = b; return this; },
    };
    await feedModulesController.list({} as never, res as never);
    expect(status).toBe(200);
    const data = (body as { data: { sources: unknown[]; signals: unknown[]; filters: unknown[] } }).data;
    expect(Array.isArray(data.sources)).toBe(true);
    expect(Array.isArray(data.signals)).toBe(true);
    expect(Array.isArray(data.filters)).toBe(true);
    expect(data.sources.length).toBeGreaterThan(0);
  });
});
