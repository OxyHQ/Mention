import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline, model-level test for the version-gated language backfill.
 *
 * `Post.find` (the ascending `_id` page cursor) and `Post.bulkWrite` are mocked
 * over a small in-memory store, so the REAL selection filter, idempotency, and
 * write shape run WITHOUT MongoDB — mirroring the in-package convention from
 * `scripts/backfillThreadRootThreadId.test.ts` / `scripts/backfillFederatedBanners.test.ts`
 * (the repo has no `mongodb-memory-server` and globally mocks mongoose). The REAL
 * `BaselineContentClassifier` (pure/synchronous) derives the languages so the
 * test validates genuine detection, not a stub.
 */

interface StoredPost {
  _id: mongoose.Types.ObjectId;
  content?: { variants?: Array<{ source: string; text: string; tag?: string }> };
  hashtags?: string[];
  federation?: { sensitive?: boolean } | null;
  postClassification?: { languages?: string[]; version?: number };
  language?: string;
}

interface CapturedOp {
  updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: Record<string, unknown> } };
}

const h = vi.hoisted(() => {
  const state: { posts: StoredPost[] } = { posts: [] };
  return { state, find: vi.fn(), bulkWrite: vi.fn() };
});

vi.mock('../models/Post', () => ({
  Post: { find: h.find, bulkWrite: h.bulkWrite },
}));

import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import { backfillPostLanguages } from '../scripts/backfillPostLanguages';

/**
 * Mirror the backfill's selection filter: a post qualifies when its canonical
 * `postClassification.languages` array is missing/empty OR it was classified
 * before the current baseline version.
 */
function matchesFilter(p: StoredPost): boolean {
  const langs = p.postClassification?.languages;
  const langsMissingOrEmpty = langs == null || (Array.isArray(langs) && langs.length === 0);
  const version = p.postClassification?.version;
  const versionStale = typeof version === 'number' && version < BASELINE_CLASSIFIER_VERSION;
  return langsMissingOrEmpty || versionStale;
}

beforeEach(() => {
  h.state.posts = [];
  h.find.mockReset();
  h.bulkWrite.mockReset();

  h.find.mockImplementation((query: { _id?: { $gt?: mongoose.Types.ObjectId } }) => ({
    sort: () => ({
      limit: (n: number) => ({
        lean: async () => {
          const gt = query._id?.$gt;
          return h.state.posts
            .filter((p) => (!gt || p._id.toString() > gt.toString()) && matchesFilter(p))
            .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
            .slice(0, n);
        },
      }),
    }),
  }));

  h.bulkWrite.mockImplementation(async (ops: CapturedOp[]) => {
    for (const op of ops) {
      const target = h.state.posts.find((p) => p._id.toString() === op.updateOne.filter._id.toString());
      if (!target) continue;
      const set = op.updateOne.update.$set;
      target.postClassification = {
        ...target.postClassification,
        languages: set['postClassification.languages'] as string[] | undefined,
        version: set['postClassification.version'] as number | undefined,
      };
      target.language = set.language as string | undefined;
    }
    return { modifiedCount: ops.length };
  });
});

describe('backfillPostLanguages', () => {
  it('derives languages for a post missing them and is idempotent', async () => {
    const id = new mongoose.Types.ObjectId();
    // A pre-multilanguage doc: stale classifier version, no languages array.
    h.state.posts = [
      {
        _id: id,
        content: { variants: [{ source: 'author', text: 'Hola, ¿cómo estás hoy amigo?' }] },
        postClassification: { version: 1 },
      },
    ];

    const first = await backfillPostLanguages({ batchSize: 100 });
    expect(first.updated).toBeGreaterThanOrEqual(1);

    const after = h.state.posts.find((p) => p._id.equals(id));
    expect(after?.postClassification?.languages?.length).toBeGreaterThanOrEqual(1);
    expect(after?.postClassification?.version).toBe(BASELINE_CLASSIFIER_VERSION);
    expect(after?.language).toBe(after?.postClassification?.languages?.[0]);

    // Second run finds nothing new (idempotent).
    const second = await backfillPostLanguages({ batchSize: 100 });
    expect(second.updated).toBe(0);
  });

  it('does not write when dryRun is set, but still reports what it would update', async () => {
    h.state.posts = [
      {
        _id: new mongoose.Types.ObjectId(),
        content: { variants: [{ source: 'author', text: 'This is a clearly English sentence for detection.' }] },
        postClassification: { version: 1 },
      },
    ];

    const result = await backfillPostLanguages({ dryRun: true });

    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(h.bulkWrite).not.toHaveBeenCalled();
    expect(h.state.posts[0].postClassification?.languages).toBeUndefined();
  });

  it('skips posts with no derivable language without fabricating one', async () => {
    h.state.posts = [
      {
        _id: new mongoose.Types.ObjectId(),
        content: { variants: [{ source: 'author', text: 'hi' }] }, // too short to detect
        postClassification: { version: 1 },
      },
    ];

    const result = await backfillPostLanguages({ batchSize: 100 });

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(0);
    expect(h.bulkWrite).not.toHaveBeenCalled();
    expect(h.state.posts[0].postClassification?.languages).toBeUndefined();
  });
});
