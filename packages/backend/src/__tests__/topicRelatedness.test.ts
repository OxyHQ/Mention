import { describe, expect, it } from 'bun:test';
import {
  buildRelations,
  DEFAULT_RELATEDNESS_PRIOR,
  pairScore,
  pairsFromItem,
  posteriorConditional,
} from '../services/topics/relatedness';

const volumes = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('topic relatedness scoring', () => {
  it('starts at the prior mean and rises with evidence, never past 1', () => {
    const { alpha, beta } = DEFAULT_RELATEDNESS_PRIOR;
    expect(posteriorConditional(0, 0)).toBeCloseTo(alpha / (alpha + beta));
    expect(posteriorConditional(2, 2)).toBeLessThan(posteriorConditional(200, 200));
    expect(posteriorConditional(1_000_000, 1_000_000)).toBeLessThanOrEqual(1);
  });

  it('scores a pair symmetrically by its weaker direction', () => {
    expect(pairScore(10, 10, 1000)).toBe(pairScore(10, 1000, 10));
    expect(pairScore(10, 10, 1000)).toBe(posteriorConditional(10, 1000));
  });
});

describe('buildRelations', () => {
  it('relates both topics of a qualifying edge and drops thin ones', () => {
    const relations = buildRelations(
      [
        { a: 'a', b: 'b', count: 5 },
        { a: 'a', b: 'c', count: 2 },
      ],
      volumes({ a: 10, b: 10, c: 10 }),
      { minCooccurrence: 3 },
    );
    expect(relations.get('a')?.map((r) => r.topic)).toEqual(['b']);
    expect(relations.get('b')?.map((r) => r.topic)).toEqual(['a']);
    expect(relations.has('c')).toBe(false);
  });

  it('keeps the top K strongest first, ties by topic id regardless of input order', () => {
    const counts = volumes({ hub: 100, a: 50, b: 50, c: 50 });
    const edges = [
      { a: 'hub', b: 'c', count: 9 },
      { a: 'hub', b: 'b', count: 5 },
      { a: 'hub', b: 'a', count: 5 },
    ];
    const forward = buildRelations(edges, counts, { topK: 2 }).get('hub');
    const reversed = buildRelations([...edges].reverse(), counts, { topK: 2 }).get('hub');
    expect(forward?.map((r) => r.topic)).toEqual(['c', 'a']);
    expect(reversed).toEqual(forward);
  });

  it('rejects input that breaks the counting invariants', () => {
    const counts = volumes({ a: 5, b: 8 });
    expect(() => buildRelations([{ a: 'a', b: 'a', count: 3 }], counts)).toThrow('itself');
    expect(() => buildRelations([{ a: 'a', b: 'b', count: 6 }], counts)).toThrow('smaller volume');
    expect(() => buildRelations([{ a: 'a', b: 'z', count: 3 }], counts)).toThrow('no volume');
    expect(() =>
      buildRelations(
        [
          { a: 'a', b: 'b', count: 3 },
          { a: 'b', b: 'a', count: 3 },
        ],
        counts,
      ),
    ).toThrow('duplicate edge');
    expect(() => buildRelations([], counts, { topK: 0 })).toThrow('topK');
  });
});

describe('pairsFromItem', () => {
  it('yields canonical unordered pairs, deduplicated and capped to the heaviest topics', () => {
    expect(
      pairsFromItem([
        { topic: 'c', weight: 1 },
        { topic: 'a', weight: 1 },
        { topic: 'a', weight: 3 },
        { topic: 'b', weight: 2 },
      ]),
    ).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
    const many = Array.from({ length: 20 }, (_, i) => ({ topic: `t${i}`, weight: i + 1 }));
    const pairs = pairsFromItem(many, 8);
    expect(pairs).toHaveLength(28);
    expect(new Set(pairs.flat()).has('t0')).toBe(false);
  });

  it('rejects non-positive weights and a cap below two', () => {
    expect(() => pairsFromItem([{ topic: 'a', weight: 0 }])).toThrow('positive finite');
    expect(() => pairsFromItem([], 1)).toThrow('at least 2');
  });
});
