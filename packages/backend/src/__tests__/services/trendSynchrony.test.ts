import { describe, expect, it } from 'bun:test';
import type { MtnTrendSynchronyConfig } from '@mention/shared-types';
import {
  mergeSynchronizedTerms,
  peakShare,
  pearson,
  type SynchronyPair,
  type SynchronyTerm,
} from '../../services/trending/trendSynchrony';

const config: MtnTrendSynchronyConfig = {
  enabled: true,
  minSeriesCorrelation: 0.85,
  minSharedPosts: 6,
  minCoverage: 0.2,
  minPeakShare: 0.3,
  maxRounds: 3,
  maxStoryTerms: 4,
  binMs: 3_600_000,
};

const PEAK_BINS = 1;
const CORPUS = new Array(9).fill(100);
const row = (term: string, series: number[], members = [term]): SynchronyTerm => ({
  term,
  members,
  series,
});
const pair = (a: string, b: string, posts: number): SynchronyPair => ({ a, b, posts });

// Quiet, then a burst in the last three bins.
const burst = [0, 0, 0, 1, 0, 2, 6, 12, 20];
const sameShape = [0, 0, 0, 0, 1, 1, 3, 6, 11];
const otherDay = [9, 14, 8, 2, 0, 0, 0, 0, 1];

describe('mergeSynchronizedTerms', () => {
  it('joins bursting terms that rise together and share posts, under the busier name', () => {
    const result = mergeSynchronizedTerms(
      [row('jensen huang', burst), row('huang', sameShape)],
      [pair('huang', 'jensen huang', 8)],
      PEAK_BINS,
      CORPUS,
      config,
    );

    expect(result.merges).toEqual([{ representative: 'jensen huang', absorbed: ['huang'] }]);
  });

  it('refuses each test the other cannot replace', () => {
    const pairs = [pair('a', 'b', 8), pair('a', 'c', 8), pair('a', 'd', 3)];
    const result = mergeSynchronizedTerms(
      [
        row('a', burst),
        row('b', otherDay), // overlaps, but peaks at another time
        row(
          'c',
          sameShape.map((n) => n * 40),
        ), // moves with it, but 8 posts are no share of 2000
        row('d', sameShape), // moves with it, but met on too few posts
      ],
      pairs,
      PEAK_BINS,
      CORPUS,
      config,
    );

    expect(result.merges).toEqual([]);
  });

  it('ignores terms that are not bursting, however well their days line up', () => {
    const flatA = [5, 9, 5, 9, 5, 9, 5, 9, 5];
    const flatB = [3, 6, 3, 6, 3, 6, 3, 6, 3];
    const result = mergeSynchronizedTerms(
      [row('a', flatA), row('b', flatB)],
      [pair('a', 'b', 20)],
      PEAK_BINS,
      CORPUS,
      config,
    );

    expect(result.merges).toEqual([]);
  });

  it("does not mistake the network's own daily rhythm for a shared story", () => {
    // Both terms hold a constant 10% and 3% of every hour, so their COUNTS are
    // perfectly correlated — they just rise in the evening like everything else.
    const corpus = [20, 30, 50, 80, 120, 200, 300, 450, 600];
    const result = mergeSynchronizedTerms(
      [
        row(
          'a',
          corpus.map((n) => n * 0.1),
        ),
        row(
          'b',
          corpus.map((n) => n * 0.03),
        ),
      ],
      [pair('a', 'b', 20)],
      PEAK_BINS,
      corpus,
      config,
    );

    expect(
      pearson(
        corpus.map((n) => n * 0.1),
        corpus.map((n) => n * 0.03),
      ),
    ).toBeCloseTo(1);
    expect(result.merges).toEqual([]);
  });

  it('judges a burst by its peak wherever it fell, so a fading story still joins', () => {
    const early = [0, 1, 2, 20, 12, 5, 2, 1, 0];
    const alike = [0, 0, 1, 11, 7, 2, 1, 0, 0];
    const result = mergeSynchronizedTerms(
      [row('a', early), row('b', alike)],
      [pair('a', 'b', 9)],
      PEAK_BINS,
      CORPUS,
      config,
    );

    expect(peakShare(early, 1)).toBeGreaterThan(0.3);
    expect(result.merges).toEqual([{ representative: 'a', absorbed: ['b'] }]);
  });

  it('ignores an hour that is still arriving instead of letting its noise decide', () => {
    // The newest hour holds 22 posts against a typical 100: a share of 5 in 22
    // must not outweigh nine hours that agree.
    const corpus = [100, 100, 100, 100, 100, 100, 100, 100, 22];
    const a = [0, 0, 1, 3, 8, 20, 12, 4, 1];
    const b = [0, 0, 1, 2, 5, 11, 7, 2, 9];
    const result = mergeSynchronizedTerms(
      [row('a', a), row('b', b)],
      [pair('a', 'b', 12)],
      PEAK_BINS,
      corpus,
      { ...config, minPeakShare: 0.2 },
    );

    expect(result.merges).toEqual([{ representative: 'a', absorbed: ['b'] }]);
  });

  it('keeps a row under the member ceiling, counting original terms', () => {
    const result = mergeSynchronizedTerms(
      [row('a', burst, ['a', 'a1', 'a2']), row('b', sameShape, ['b', 'b1'])],
      [pair('a', 'b', 8)],
      PEAK_BINS,
      CORPUS,
      config,
    );

    expect(result.merges).toEqual([]);
    expect(result.refusedForSize).toEqual(['a+b']);
  });

  it('gives the same answer whatever order the pairs arrive in, and is off when disabled', () => {
    const terms = [
      row('a', burst),
      row('b', sameShape),
      row(
        'c',
        sameShape.map((n) => n + 1),
      ),
    ];
    const pairs = [pair('a', 'b', 8), pair('a', 'c', 8), pair('b', 'c', 8)];

    expect(mergeSynchronizedTerms(terms, pairs, PEAK_BINS, CORPUS, config)).toEqual(
      mergeSynchronizedTerms(terms, [...pairs].reverse(), PEAK_BINS, CORPUS, config),
    );
    expect(
      mergeSynchronizedTerms(terms, pairs, PEAK_BINS, CORPUS, { ...config, enabled: false }).merges,
    ).toEqual([]);
  });
});

describe('pearson', () => {
  it('is 0 for a flat series rather than NaN', () => {
    expect(pearson([2, 2, 2], [1, 2, 3])).toBe(0);
  });
});
