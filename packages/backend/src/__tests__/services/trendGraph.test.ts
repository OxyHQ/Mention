import { describe, expect, it } from 'vitest';
import type { TrendGraphEdgeDTO, TrendGraphNodeDTO } from '@mention/shared-types';
import { buildTrendGraph, type TrendGraphNodeInput } from '../../services/trending/trendGraph';
import { applyGraphFilters } from '../../services/trending/trendGraphQuery';

const AT = new Date('2026-08-02T18:00:00Z');

const node = (
  term: string,
  volume: number,
  extra: Partial<TrendGraphNodeInput> = {},
): TrendGraphNodeInput => ({
  term,
  volume,
  authorCount: 3,
  languages: ['en'],
  regions: [],
  ...extra,
});

describe('buildTrendGraph', () => {
  it('stores each pair once, in a stable order', () => {
    const graph = buildTrendGraph(
      AT,
      [node('ukraine', 40), node('kyiv', 10)],
      [{ a: 'kyiv', b: 'ukraine', posts: 8 }],
      [],
      new Map(),
    );

    expect(graph.edges).toEqual([{ a: 'kyiv', b: 'ukraine', posts: 8, linked: false }]);
  });

  it('marks only the pairs the clusterer actually accepted', () => {
    // `a`–`c` share a story transitively through `b` without a qualifying link
    // of their own. Marking that edge linked would claim evidence never had.
    const graph = buildTrendGraph(
      AT,
      [node('a', 10), node('b', 10), node('c', 10)],
      [
        { a: 'a', b: 'b', posts: 8 },
        { a: 'b', b: 'c', posts: 8 },
        { a: 'a', b: 'c', posts: 4 },
      ],
      [
        { a: 'a', b: 'b' },
        { a: 'b', b: 'c' },
      ],
      new Map([
        ['a', 'a'],
        ['b', 'a'],
        ['c', 'a'],
      ]),
    );

    const byKey = new Map(graph.edges.map((edge) => [`${edge.a}${edge.b}`, edge.linked]));
    expect(byKey.get('ab')).toBe(true);
    expect(byKey.get('bc')).toBe(true);
    expect(byKey.get('ac')).toBe(false);
  });

  it('carries the story a node was merged into, and nothing for one that was not', () => {
    const graph = buildTrendGraph(
      AT,
      [node('ukraine', 40), node('kyiv', 10), node('eurovision', 25)],
      [],
      [],
      new Map([
        ['ukraine', 'ukraine'],
        ['kyiv', 'ukraine'],
      ]),
    );

    const byTerm = new Map(graph.nodes.map((graphNode) => [graphNode.term, graphNode.story]));
    expect(byTerm.get('kyiv')).toBe('ukraine');
    // The representative points at itself, so a client can find a story's
    // centre without comparing volumes itself.
    expect(byTerm.get('ukraine')).toBe('ukraine');
    expect(byTerm.get('eurovision')).toBeUndefined();
  });

  it('never keeps an edge whose endpoint was cut, and reports the loss', () => {
    // A node cap that left its edges behind would store a graph referring to
    // terms it does not contain.
    const many = Array.from({ length: 320 }, (_, index) =>
      node(`t${String(index).padStart(3, '0')}`, 320 - index),
    );
    const graph = buildTrendGraph(
      AT,
      many,
      [{ a: 't000', b: 't319', posts: 9 }],
      [],
      new Map(),
    );

    const terms = new Set(graph.nodes.map((graphNode) => graphNode.term));
    expect(terms.has('t319')).toBe(false);
    expect(graph.edges).toEqual([]);
    // And it says so. A truncation that is not reported reads as "this is the
    // whole graph" precisely when it is not.
    expect(graph.droppedEdges).toBe(1);
  });
});

describe('applyGraphFilters', () => {
  const nodes: TrendGraphNodeDTO[] = [
    { term: 'ukraine', volume: 40, authorCount: 5, languages: ['en'], regions: ['us'] },
    { term: 'kyiv', volume: 10, authorCount: 3, languages: ['en', 'de'], regions: [] },
    { term: 'ceuta', volume: 6, authorCount: 3, languages: ['es'], regions: ['es'] },
  ];
  const edges: TrendGraphEdgeDTO[] = [
    { a: 'kyiv', b: 'ukraine', posts: 8, linked: true },
    { a: 'ceuta', b: 'ukraine', posts: 3, linked: false },
  ];

  it('compares languages on the base subtag, as ranking does', () => {
    const result = applyGraphFilters(nodes, edges, { language: 'en-GB' });

    expect(result.nodes.map((node_) => node_.term)).toEqual(['ukraine', 'kyiv']);
  });

  it('drops every edge that lost an endpoint', () => {
    // A surviving edge to a filtered-out node draws a line to nothing, and any
    // ratio from it divides by a volume the client cannot see.
    const result = applyGraphFilters(nodes, edges, { language: 'es' });

    // Only `ceuta` speaks Spanish, so both of its edges lost their other end.
    expect(result.nodes.map((node_) => node_.term)).toEqual(['ceuta']);
    expect(result.edges).toEqual([]);
  });

  it('never excludes on an axis a node has no data for', () => {
    // `postClassification.region` is sparse. Excluding the nodes that lack it
    // would make a region filter quietly mean "terms we happen to have region
    // data for", which is most of the graph missing.
    const result = applyGraphFilters(nodes, edges, { region: 'us' });

    expect(result.nodes.map((node_) => node_.term)).toEqual(['ukraine', 'kyiv']);
    expect(result.edges).toEqual([{ a: 'kyiv', b: 'ukraine', posts: 8, linked: true }]);
  });
});
