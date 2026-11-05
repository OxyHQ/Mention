import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_RELATEDNESS_PRIOR,
  buildRelations,
  pairScore,
  pairsFromItem,
  posteriorConditional,
  type CooccurrenceEdge,
} from '../services/topics/relatedness';

const volumes = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('posteriorConditional', () => {
  it('starts at the prior mean when there is no evidence', () => {
    const prior = DEFAULT_RELATEDNESS_PRIOR;
    expect(posteriorConditional(0, 0, prior)).toBeCloseTo(prior.alpha / (prior.alpha + prior.beta));
  });

  it('rises toward the observed ratio as evidence grows', () => {
    const few = posteriorConditional(2, 2);
    // The prior weighs about 50 pseudo-items, so 200 of 200 is still shrunk toward
    // the prior, and thousands of items are needed to approach the raw ratio.
    const many = posteriorConditional(200, 200);
    const thousands = posteriorConditional(5000, 5000);
    expect(few).toBeLessThan(many);
    expect(many).toBeLessThan(thousands);
    expect(thousands).toBeGreaterThan(0.98);
  });

  it('never exceeds 1, however strong the evidence', () => {
    expect(posteriorConditional(1_000_000, 1_000_000)).toBeLessThanOrEqual(1);
  });
});

describe('pairScore', () => {
  it('is symmetric in its two topics', () => {
    expect(pairScore(5, 40, 90)).toBe(pairScore(5, 90, 40));
  });

  it('takes the weaker direction, so a small topic inside a large one stays weak', () => {
    // Every post about the small topic is about the large one, but not the reverse.
    const direction = posteriorConditional(10, 10);
    const reverse = posteriorConditional(10, 1000);
    expect(pairScore(10, 10, 1000)).toBe(Math.min(direction, reverse));
    expect(pairScore(10, 10, 1000)).toBeLessThan(direction);
  });

  it('ranks strong, well-evidenced pairs above thin ones at the same ratio', () => {
    expect(pairScore(30, 30, 30)).toBeGreaterThan(pairScore(1, 1, 1));
  });
});

describe('buildRelations', () => {
  it('relates both topics of an edge, each to the other', () => {
    const relations = buildRelations(
      [{ a: 'donald-trump', b: 'white-house', count: 40 }],
      volumes({ 'donald-trump': 60, 'white-house': 50 }),
    );
    expect(relations.get('donald-trump')?.map((r) => r.topic)).toEqual(['white-house']);
    expect(relations.get('white-house')?.map((r) => r.topic)).toEqual(['donald-trump']);
    expect(relations.get('donald-trump')?.[0].cooccurrence).toBe(40);
  });

  it('drops pairs below the minimum shared items', () => {
    const relations = buildRelations([{ a: 'x', b: 'y', count: 2 }], volumes({ x: 10, y: 10 }), {
      minCooccurrence: 3,
    });
    expect(relations.size).toBe(0);
  });

  it('keeps only the top K per topic, strongest first', () => {
    const edges: CooccurrenceEdge[] = [];
    const counts = volumes({ hub: 1000 });
    for (let i = 0; i < 10; i += 1) {
      const topic = `t${i}`;
      counts.set(topic, 100);
      edges.push({ a: 'hub', b: topic, count: 10 + i });
    }
    const related = buildRelations(edges, counts, { topK: 3 }).get('hub') ?? [];
    expect(related.map((r) => r.topic)).toEqual(['t9', 't8', 't7']);
  });

  it('breaks score ties by topic id, so the output does not depend on input order', () => {
    const counts = volumes({ hub: 50, a: 50, b: 50 });
    const forward = buildRelations(
      [
        { a: 'hub', b: 'a', count: 5 },
        { a: 'hub', b: 'b', count: 5 },
      ],
      counts,
    );
    const reversed = buildRelations(
      [
        { a: 'hub', b: 'b', count: 5 },
        { a: 'hub', b: 'a', count: 5 },
      ],
      counts,
    );
    expect(forward.get('hub')).toEqual(reversed.get('hub'));
    expect(forward.get('hub')?.map((r) => r.topic)).toEqual(['a', 'b']);
  });

  it('is deterministic across repeated runs', () => {
    const counts = volumes({ a: 20, b: 30, c: 40 });
    const edges = [
      { a: 'a', b: 'b', count: 5 },
      { a: 'a', b: 'c', count: 9 },
      { a: 'b', b: 'c', count: 4 },
    ];
    expect(buildRelations(edges, counts)).toEqual(buildRelations(edges, counts));
  });

  it('rejects input that breaks the counting invariants instead of guessing', () => {
    const counts = volumes({ a: 5, b: 8 });
    expect(() => buildRelations([{ a: 'a', b: 'a', count: 3 }], counts)).toThrow('itself');
    expect(() => buildRelations([{ a: 'a', b: 'b', count: 0 }], counts)).toThrow(
      'positive integer',
    );
    expect(() => buildRelations([{ a: 'a', b: 'b', count: 1.5 }], counts)).toThrow(
      'positive integer',
    );
    expect(() => buildRelations([{ a: 'a', b: 'b', count: 6 }], counts)).toThrow('smaller volume');
    expect(() => buildRelations([{ a: 'a', b: 'zz', count: 3 }], counts)).toThrow('no volume');
    expect(() =>
      buildRelations(
        [
          { a: 'a', b: 'b', count: 3 },
          { a: 'b', b: 'a', count: 3 },
        ],
        counts,
      ),
    ).toThrow('duplicate edge');
  });

  it('rejects invalid options', () => {
    const counts = volumes({ a: 5, b: 8 });
    expect(() => buildRelations([], counts, { topK: 0 })).toThrow('topK');
    expect(() => buildRelations([], counts, { minCooccurrence: 0 })).toThrow('minCooccurrence');
    expect(() => buildRelations([], counts, { prior: { alpha: 0, beta: 1 } })).toThrow(
      'Beta prior',
    );
  });

  it('handles a large corpus with the same guarantees', () => {
    const counts = new Map<string, number>();
    const edges: CooccurrenceEdge[] = [];
    for (let i = 0; i < 2000; i += 1) counts.set(`t${i}`, 50 + (i % 7));
    for (let i = 0; i < 2000; i += 1) {
      for (let step = 1; step <= 5; step += 1) {
        const j = (i + step) % 2000;
        edges.push({ a: `t${i}`, b: `t${j}`, count: 3 + ((i * step) % 9) });
      }
    }
    const relations = buildRelations(edges, counts, { topK: 20 });
    expect(relations.size).toBe(2000);
    for (const related of relations.values()) {
      expect(related.length).toBeLessThanOrEqual(20);
      for (let k = 1; k < related.length; k += 1) {
        expect(related[k - 1].score).toBeGreaterThanOrEqual(related[k].score);
      }
    }
  });
});

describe('pairsFromItem', () => {
  it('yields every unordered pair once, in canonical order', () => {
    const pairs = pairsFromItem([
      { topic: 'c', weight: 1 },
      { topic: 'a', weight: 1 },
      { topic: 'b', weight: 1 },
    ]);
    expect(pairs).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  it('keeps the heaviest weight of a duplicated topic and counts it once', () => {
    expect(
      pairsFromItem([
        { topic: 'a', weight: 1 },
        { topic: 'a', weight: 5 },
        { topic: 'b', weight: 2 },
      ]),
    ).toEqual([['a', 'b']]);
  });

  it('caps an item at its heaviest topics, bounding the pairs it adds', () => {
    const topics = Array.from({ length: 20 }, (_, i) => ({ topic: `t${i}`, weight: i + 1 }));
    const pairs = pairsFromItem(topics, 8);
    expect(pairs).toHaveLength((8 * 7) / 2);
    const kept = new Set(pairs.flat());
    expect(kept.has('t19')).toBe(true);
    expect(kept.has('t0')).toBe(false);
  });

  it('is deterministic and independent of input order', () => {
    const items = [
      { topic: 'x', weight: 2 },
      { topic: 'y', weight: 2 },
      { topic: 'z', weight: 1 },
    ];
    expect(pairsFromItem(items)).toEqual(pairsFromItem([...items].reverse()));
  });

  it('rejects weights that are not positive finite numbers, and a cap below two', () => {
    expect(() => pairsFromItem([{ topic: 'a', weight: 0 }])).toThrow('positive finite');
    expect(() => pairsFromItem([{ topic: 'a', weight: Number.NaN }])).toThrow('positive finite');
    expect(() => pairsFromItem([], 1)).toThrow('at least 2');
  });
});
