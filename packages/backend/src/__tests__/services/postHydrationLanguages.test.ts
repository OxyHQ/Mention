import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * ACCOUNT LANGUAGES ON THE CACHED IDENTITY.
 *
 * Oxy models account languages as full BCP-47 locales (`es-ES`), primary first.
 * `resolveUserSummaries` resolves them ONCE — through the SDK's `getUserLanguages`
 * (normalize → validate → dedupe) — and caches them next to the identity, so the
 * feed can read the VIEWER's languages (`loadViewerLanguages`) with no extra Oxy
 * round trip. They live on {@link CachedUserSummary}, deliberately NOT on the
 * `PostUser` DTO, so they never ship inside a post's author object.
 *
 * The Redis cache and the Oxy client are mocked so the REAL `resolveUserSummaries`
 * runs against a controlled bulk fetch (same harness as `postHydrationMentions`).
 */

const { getUserById, getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

// `server.ts` constructs a live OxyServices client at import time; stub it.
vi.mock('../../../server', () => ({ oxy: { getUserById } }));

// The bulk service-token client used by resolveUserSummaries for cache misses.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds }),
}));

// Mongo models are only touched on other hydration paths; stub to empty objects.
vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../models/Poll', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/UserSettings', () => ({ UserSettings: {} }));
// The starter-pack CURATION aggregation runs on the cache-fill path (it stamps the
// ranking-side `starterPackScore`). No DB here → no packs → no scores.
vi.mock('../../models/StarterPack', () => ({
  StarterPack: { aggregate: async () => [] },
  default: { aggregate: async () => [] },
}));
vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

// The Redis-backed user-summary cache: start cold (all misses), capture writes.
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
  invalidate: vi.fn(async () => undefined),
}));

import { resolveUserSummaries } from '../../services/PostHydrationService';

/** A canonical Oxy user carrying the account's languages. */
function makeOxyUser(id: string, languages?: unknown) {
  return {
    id,
    username: 'viewer',
    name: { displayName: 'Viewer' },
    ...(languages === undefined ? {} : { languages }),
  };
}

describe('resolveUserSummaries — account languages', () => {
  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
  });

  it('caches the account locales, canonicalized and primary-first', async () => {
    getUsersByIds.mockResolvedValue([makeOxyUser('u1', ['es-es', 'EN-us'])]);

    const resolved = await resolveUserSummaries(['u1']);

    expect(resolved.get('u1')?.languages).toEqual(['es-ES', 'en-US']);
    // Ranking-only: never leaks into the post author DTO.
    expect(resolved.get('u1')?.user).not.toHaveProperty('languages');
  });

  it('drops unsupported / malformed entries and dedupes', async () => {
    getUsersByIds.mockResolvedValue([makeOxyUser('u1', ['es-ES', 'zz-ZZ', 'es-ES', 42, ''])]);

    const resolved = await resolveUserSummaries(['u1']);

    expect(resolved.get('u1')?.languages).toEqual(['es-ES']);
  });

  it('omits the field when the account declares no languages', async () => {
    getUsersByIds.mockResolvedValue([makeOxyUser('u1')]);

    const resolved = await resolveUserSummaries(['u1']);

    expect(resolved.get('u1')?.languages).toBeUndefined();
  });

  it('serves the cached languages on a hit, without re-fetching from Oxy', async () => {
    getUsersByIds.mockResolvedValue([makeOxyUser('u1', ['es-ES'])]);
    await resolveUserSummaries(['u1']);
    getUsersByIds.mockReset();

    const resolved = await resolveUserSummaries(['u1']);

    expect(resolved.get('u1')?.languages).toEqual(['es-ES']);
    expect(getUsersByIds).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });
});
