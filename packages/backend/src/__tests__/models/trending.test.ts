import { describe, it, expect } from 'vitest';
import TrendingModel, { TRENDING_TTL_SECONDS } from '../../models/Trending';

/**
 * Schema-level coverage for the `Trending` model indexes.
 *
 * The trending collection is append-only (a full batch every 30 minutes), so it
 * must be bounded by a TTL index; the history aggregation also relies on the
 * single-field `{ calculatedAt: 1 }` index for its windowed `$gte` scan. These
 * assertions read the declared schema indexes directly (no DB needed) so a
 * regression that drops the TTL — or reintroduces a conflicting plain
 * `{ calculatedAt: 1 }` index — fails here.
 */

type IndexEntry = [Record<string, unknown>, Record<string, unknown> | undefined];

function schemaIndexes(): IndexEntry[] {
  return TrendingModel.schema.indexes() as IndexEntry[];
}

describe('Trending model — indexes', () => {
  it('exports a 90-day retention window', () => {
    expect(TRENDING_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
  });

  it('declares a TTL index on calculatedAt with the retention window', () => {
    const ttl = schemaIndexes().find(
      ([keys, options]) =>
        Object.keys(keys).length === 1 &&
        keys.calculatedAt === 1 &&
        typeof options?.expireAfterSeconds === 'number',
    );
    expect(ttl).toBeDefined();
    expect(ttl?.[1]?.expireAfterSeconds).toBe(TRENDING_TTL_SECONDS);
  });

  it('declares exactly ONE single-field { calculatedAt: 1 } index (no plain/TTL conflict)', () => {
    const singleFieldCalcAt = schemaIndexes().filter(
      ([keys]) => Object.keys(keys).length === 1 && keys.calculatedAt === 1,
    );
    expect(singleFieldCalcAt).toHaveLength(1);
  });

  it('keeps the compound { calculatedAt: -1, score: -1 } index', () => {
    const compound = schemaIndexes().find(
      ([keys]) => keys.calculatedAt === -1 && keys.score === -1,
    );
    expect(compound).toBeDefined();
  });

  it('keeps the unique { name: 1, calculatedAt: 1 } index', () => {
    const unique = schemaIndexes().find(
      ([keys, options]) =>
        keys.name === 1 && keys.calculatedAt === 1 && options?.unique === true,
    );
    expect(unique).toBeDefined();
  });
});
