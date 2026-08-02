import { describe, expect, it } from 'vitest';
import type { MtnTrendClusteringConfig } from '@mention/shared-types';
import {
  buildClusterMap,
  clusterTrendTerms,
  type TrendClusterCandidate,
  type TrendTermPair,
} from '../../services/trending/trendClustering';

const config: MtnTrendClusteringConfig = {
  enabled: true,
  minPairPosts: 3,
  strongLinkRatio: 0.6,
  weakLinkRatio: 0.2,
  maxClusterSize: 6,
};

const candidates = (entries: Record<string, number>): TrendClusterCandidate[] =>
  Object.entries(entries).map(([term, volume]) => ({ term, volume }));

describe('clusterTrendTerms — one story, one row', () => {
  it('merges a subordinate name into the story it cannot be written without', () => {
    // 8 of Kyiv's 10 posts also say Ukraine (0.8 strong); 8 of Ukraine's 40 say
    // Kyiv (0.2 weak). The asymmetry IS the signal.
    const result = clusterTrendTerms(
      candidates({ ukraine: 40, kyiv: 10 }),
      [{ a: 'kyiv', b: 'ukraine', posts: 8 }],
      config,
    );

    expect(result.clusters).toEqual([{ representative: 'ukraine', members: ['ukraine', 'kyiv'] }]);
  });

  it('reports the row under its BIGGEST member, never an invented umbrella', () => {
    const result = clusterTrendTerms(
      candidates({ zelensky: 12, ukraine: 40 }),
      [{ a: 'ukraine', b: 'zelensky', posts: 10 }],
      config,
    );

    expect(result.clusters[0].representative).toBe('ukraine');
    expect(result.clusters[0].members[0]).toBe('ukraine');
  });

  it('refuses a merge the DOMINANT term never returns', () => {
    // Every one of `giveaway`'s 4 posts says `music` — a perfect strong side.
    // But `music` has 400 posts, so it comes back 1% of the time: `giveaway` is
    // riding a broad term, not sharing its story. A one-directional test would
    // merge these.
    const result = clusterTrendTerms(
      candidates({ music: 400, giveaway: 4 }),
      [{ a: 'giveaway', b: 'music', posts: 4 }],
      config,
    );

    expect(result.clusters).toEqual([]);
  });

  it('ignores a link resting on too few posts', () => {
    // Two rare terms that met twice score 1.0 in BOTH directions. Ratios over
    // two posts are noise, and without this floor noise merges perfectly.
    const result = clusterTrendTerms(
      candidates({ alpha: 2, beta: 2 }),
      [{ a: 'alpha', b: 'beta', posts: 2 }],
      config,
    );

    expect(result.clusters).toEqual([]);
  });

  it('stops a chain of reasonable links from walking across unrelated stories', () => {
    // Each link passes on its own; transitively they would put eight terms —
    // two stories joined at a shared word — in one row.
    const terms = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const chain: TrendTermPair[] = terms
      .slice(0, -1)
      .map((term, index) => ({ a: term, b: terms[index + 1], posts: 8 }));

    const result = clusterTrendTerms(
      candidates(Object.fromEntries(terms.map((term) => [term, 10]))),
      chain,
      config,
    );

    // The chain is CUT, not collapsed: the terms past the ceiling form their
    // own row rather than vanishing, so no post stops being reachable.
    for (const cluster of result.clusters) {
      expect(cluster.members.length).toBeLessThanOrEqual(config.maxClusterSize);
    }
    expect(result.clusters.flatMap((cluster) => cluster.members).sort()).toEqual(terms);
    // The refusal is REPORTED. A merge dropped in silence is indistinguishable
    // from clustering never having run.
    expect(result.refusedForSize.length).toBeGreaterThan(0);
  });

  it('names a tied row by the phrase, never a bare fragment of it', () => {
    // A phrase and the words inside it are counted over the SAME posts, so a
    // name and its fragments arrive at identical volume — `luis`, `sampedro`
    // and `luis sampedro` all measured 4 in the live window. Volume cannot
    // choose between them, and alphabetical order picks a fragment.
    const result = clusterTrendTerms(
      candidates({ luis: 4, sampedro: 4, 'luis sampedro': 4 }),
      [
        { a: 'luis', b: 'sampedro', posts: 4 },
        { a: 'luis', b: 'luis sampedro', posts: 4 },
      ],
      config,
    );

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].representative).toBe('luis sampedro');
  });

  it('cannot choose between two phrases of equal length — a known limit', () => {
    // `jose luis` and `luis sampedro` are both two tokens, so the tie-break has
    // nothing left to compare and falls through to lexicographic order. The
    // name this row wants is `jose luis sampedro`, which no candidate can be:
    // `MtnConfig.trending.terms.maxPhraseTokens` is 2, so a three-word name is
    // only ever present as its two-word windows. Pinned as a LIMIT rather than
    // left implicit, so raising that ceiling shows up here as a changed
    // expectation instead of passing unnoticed.
    const result = clusterTrendTerms(
      candidates({ 'jose luis': 4, 'luis sampedro': 4 }),
      [{ a: 'jose luis', b: 'luis sampedro', posts: 4 }],
      config,
    );

    expect(result.clusters[0].representative).toBe('jose luis');
  });

  it('is independent of the order pairs arrive in', () => {
    const input = candidates({ ukraine: 40, kyiv: 10, zelensky: 12, russia: 30 });
    const pairs: TrendTermPair[] = [
      { a: 'kyiv', b: 'ukraine', posts: 8 },
      { a: 'ukraine', b: 'zelensky', posts: 10 },
      { a: 'russia', b: 'ukraine', posts: 20 },
    ];

    const forward = clusterTrendTerms(input, pairs, config);
    const reversed = clusterTrendTerms(input, [...pairs].reverse(), config);

    expect(forward).toEqual(reversed);
    expect(forward.clusters[0].members).toEqual(['ukraine', 'russia', 'zelensky', 'kyiv']);
  });

  it('leaves an unlinked term alone rather than dropping it', () => {
    // Clustering may only ever JOIN rows. A term in no cluster keeps being
    // reported exactly as before, so the caller needs no fallback.
    const result = clusterTrendTerms(
      candidates({ ukraine: 40, kyiv: 10, eurovision: 25 }),
      [{ a: 'kyiv', b: 'ukraine', posts: 8 }],
      config,
    );

    expect(result.clusters.flatMap((cluster) => cluster.members)).not.toContain('eurovision');
  });

  it('does nothing at all when disabled', () => {
    const result = clusterTrendTerms(
      candidates({ ukraine: 40, kyiv: 10 }),
      [{ a: 'kyiv', b: 'ukraine', posts: 8 }],
      { ...config, enabled: false },
    );

    expect(result).toEqual({ clusters: [], refusedForSize: [] });
  });

  it('ignores a pair naming a term that did not survive the floors', () => {
    const result = clusterTrendTerms(
      candidates({ ukraine: 40 }),
      [{ a: 'kyiv', b: 'ukraine', posts: 8 }],
      config,
    );

    expect(result.clusters).toEqual([]);
  });
});

describe('buildClusterMap', () => {
  it('maps every member to its row, the representative included', () => {
    const map = buildClusterMap([{ representative: 'ukraine', members: ['ukraine', 'kyiv'] }]);

    expect(map.get('kyiv')).toBe('ukraine');
    expect(map.get('ukraine')).toBe('ukraine');
    expect(map.has('eurovision')).toBe(false);
  });
});
