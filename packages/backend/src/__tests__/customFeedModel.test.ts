import { describe, it, expect } from 'vitest';

/**
 * Task 1 — the evolved CustomFeed model stores a composable `definition`
 * ({ mode, sources[], signals[], filters[] }) plus an `icon`, while still
 * carrying the legacy filter fields (read-only, for the one-shot migration).
 *
 * Offline construct → cast → toObject round-trip (the repo has no
 * mongodb-memory-server); no DB connection is opened.
 */

import CustomFeed from '../models/CustomFeed';

describe('CustomFeed model — definition', () => {
  it('round-trips a stored definition + icon (params preserved as Mixed)', () => {
    const doc = new CustomFeed({
      ownerOxyUserId: 'owner-1',
      title: 'Comics',
      isPublic: true,
      icon: 'sparkles',
      definition: {
        mode: 'ranked',
        sources: [
          { module: 'accounts', enabled: true, params: { authorIds: ['a1', 'a2'] } },
          { module: 'keywords', enabled: true, params: { keywords: ['comic'], hashtags: ['comics'] } },
        ],
        signals: [{ module: 'engagement', enabled: true, weight: 2 }],
        filters: [{ module: 'noReplies', enabled: true }],
      },
    });

    const obj = doc.toObject();
    expect(obj.icon).toBe('sparkles');
    expect(obj.definition?.mode).toBe('ranked');
    expect(obj.definition?.sources).toHaveLength(2);
    expect(obj.definition?.sources[0]).toMatchObject({ module: 'accounts', enabled: true });
    // `params` is a Mixed subtree — the arbitrary keys survive the round-trip.
    expect(obj.definition?.sources[0].params).toEqual({ authorIds: ['a1', 'a2'] });
    expect(obj.definition?.signals[0]).toMatchObject({ module: 'engagement', enabled: true, weight: 2 });
    expect(obj.definition?.filters[0]).toMatchObject({ module: 'noReplies', enabled: true });
  });

  it('accepts a chronological definition and passes validateSync', () => {
    const doc = new CustomFeed({
      ownerOxyUserId: 'owner-1',
      title: 'Chrono',
      definition: { mode: 'chronological', sources: [{ module: 'keywords', enabled: true }], signals: [], filters: [] },
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('rejects an invalid definition mode via schema validation', () => {
    const doc = new CustomFeed({
      ownerOxyUserId: 'owner-1',
      title: 'Bad',
      definition: { mode: 'nonsense', sources: [], signals: [], filters: [] },
    });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors['definition.mode']).toBeDefined();
  });

  it('still constructs the legacy shape (read path for the migration)', () => {
    const doc = new CustomFeed({
      ownerOxyUserId: 'owner-1',
      title: 'Legacy',
      memberOxyUserIds: ['m1', 'm2'],
      keywords: ['art'],
      includeReplies: false,
      includeBoosts: false,
      includeMedia: false,
      language: 'es',
    });
    const obj = doc.toObject();
    expect(obj.memberOxyUserIds).toEqual(['m1', 'm2']);
    expect(obj.keywords).toEqual(['art']);
    expect(obj.includeReplies).toBe(false);
    expect(obj.language).toBe('es');
    expect(obj.definition).toBeUndefined();
  });

  it('indexes the owner id', () => {
    expect(CustomFeed.schema.path('ownerOxyUserId').options.index).toBe(true);
  });
});
