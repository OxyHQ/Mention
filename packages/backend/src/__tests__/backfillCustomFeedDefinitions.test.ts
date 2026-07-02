import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Task 2 — one-shot migration mapping legacy CustomFeed fields → a composable
 * `definition`. `CustomFeed.find` (ascending `_id` page cursor) and
 * `CustomFeed.bulkWrite` are mocked over an in-memory store so the REAL selection
 * filter, idempotency, and write shape run without MongoDB (mirroring the
 * `backfillPostLanguages` convention).
 */

interface StoredFeed {
  _id: mongoose.Types.ObjectId;
  ownerOxyUserId: string;
  memberOxyUserIds?: string[];
  keywords?: string[];
  language?: string;
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
  definition?: unknown;
}

interface CapturedOp {
  updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: Record<string, unknown> } };
}

const h = vi.hoisted(() => ({ state: { feeds: [] as StoredFeed[] }, find: vi.fn(), bulkWrite: vi.fn() }));

vi.mock('../models/CustomFeed', () => ({
  default: { find: h.find, bulkWrite: h.bulkWrite },
}));

import { backfillCustomFeedDefinitions } from '../scripts/backfillCustomFeedDefinitions';

/** A feed qualifies when it has no stored definition yet. */
function matchesFilter(f: StoredFeed): boolean {
  return f.definition == null;
}

beforeEach(() => {
  h.state.feeds = [];
  h.find.mockReset();
  h.bulkWrite.mockReset();

  h.find.mockImplementation((query: { _id?: { $gt?: mongoose.Types.ObjectId } }) => ({
    sort: () => ({
      limit: (n: number) => ({
        lean: async () => {
          const gt = query._id?.$gt;
          return h.state.feeds
            .filter((f) => (!gt || f._id.toString() > gt.toString()) && matchesFilter(f))
            .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
            .slice(0, n);
        },
      }),
    }),
  }));

  h.bulkWrite.mockImplementation(async (ops: CapturedOp[]) => {
    for (const op of ops) {
      const target = h.state.feeds.find((f) => f._id.toString() === op.updateOne.filter._id.toString());
      if (target) target.definition = op.updateOne.update.$set.definition;
    }
    return { modifiedCount: ops.length };
  });
});

describe('backfillCustomFeedDefinitions', () => {
  it('maps legacy authors + keywords + toggles + owner exclusion, and is idempotent', async () => {
    const id = new mongoose.Types.ObjectId();
    h.state.feeds = [
      {
        _id: id,
        ownerOxyUserId: 'owner-1',
        memberOxyUserIds: ['a1', 'a2'],
        keywords: ['comic'],
        language: 'en',
        includeReplies: false,
        includeBoosts: false,
      },
    ];

    const first = await backfillCustomFeedDefinitions({ batchSize: 100 });
    expect(first.updated).toBe(1);

    const migrated = h.state.feeds.find((f) => f._id.equals(id));
    const def = migrated?.definition as {
      mode: string;
      sources: Array<{ module: string; params?: Record<string, unknown> }>;
      filters: Array<{ module: string; params?: Record<string, unknown> }>;
    };
    expect(def.mode).toBe('chronological');
    expect(def.sources.map((s) => s.module)).toEqual(['accounts', 'keywords']);
    expect(def.sources[0].params).toEqual({ authorIds: ['a1', 'a2'] });
    const filterModules = def.filters.map((f) => f.module);
    expect(filterModules).toContain('languagePreference');
    expect(filterModules).toContain('noReplies');
    expect(filterModules).toContain('noBoosts');
    // owner-1 is not among the members → excluded via muteBlock
    const muteBlock = def.filters.find((f) => f.module === 'muteBlock');
    expect(muteBlock?.params).toEqual({ excludedIds: ['owner-1'] });

    // Second run finds nothing (a stored definition removes the feed from the filter).
    const second = await backfillCustomFeedDefinitions({ batchSize: 100 });
    expect(second.updated).toBe(0);
  });

  it('does not exclude the owner when the owner is an explicit member', async () => {
    h.state.feeds = [
      { _id: new mongoose.Types.ObjectId(), ownerOxyUserId: 'owner-1', memberOxyUserIds: ['owner-1', 'a2'] },
    ];
    await backfillCustomFeedDefinitions({ batchSize: 100 });
    const def = h.state.feeds[0].definition as { filters: Array<{ module: string }> };
    expect(def.filters.some((f) => f.module === 'muteBlock')).toBe(false);
  });

  it('maps includeMedia=false to textOnly', async () => {
    h.state.feeds = [
      { _id: new mongoose.Types.ObjectId(), ownerOxyUserId: 'owner-1', keywords: ['x'], includeMedia: false },
    ];
    await backfillCustomFeedDefinitions({ batchSize: 100 });
    const def = h.state.feeds[0].definition as { filters: Array<{ module: string }> };
    expect(def.filters.some((f) => f.module === 'textOnly')).toBe(true);
  });

  it('does not write when dryRun is set, but reports what it would migrate', async () => {
    h.state.feeds = [
      { _id: new mongoose.Types.ObjectId(), ownerOxyUserId: 'owner-1', keywords: ['x'] },
    ];
    const result = await backfillCustomFeedDefinitions({ dryRun: true });
    expect(result.updated).toBe(1);
    expect(h.bulkWrite).not.toHaveBeenCalled();
    expect(h.state.feeds[0].definition).toBeUndefined();
  });
});
