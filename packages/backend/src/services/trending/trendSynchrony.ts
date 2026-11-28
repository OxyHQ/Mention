// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Join the names of one story that are not written in the same posts.
 *
 * Co-occurrence ({@link ./trendClustering}) needs two terms to share posts, and
 * most of a big story does not: the network writes `Huang`, `Jensen`, `Nvidia
 * board` and `Chinese` about one event while rarely writing `Jensen Huang`
 * beside them. What those terms share instead is the SHAPE of their day — they
 * start together and rise together — and that is a fact the posts already carry,
 * with no word list and no language knowledge.
 *
 * Two terms are joined only when BOTH hold:
 *  - their hourly series are strongly correlated, and
 *  - a real share of the smaller term's posts also carry the other term.
 *
 * Neither alone is safe. Correlation alone joins anything that peaks at
 * lunchtime; overlap alone joins every niche word to the broad word it rides.
 * A third condition keeps flat terms out: both must have a clear peak, because
 * two all-day terms correlate through the daily cycle without sharing a story.
 *
 * Pure and storage-free, like `trendClustering`: it takes counts and series and
 * returns groupings. Windows and queries live in `trendDetection`.
 */

import type { MtnTrendSynchronyConfig } from '@mention/shared-types';

/**
 * Bins with fewer posts than this in the whole corpus say nothing about a
 * term's SHARE (one post is 100% of an empty hour), and an hour the window did
 * not cover at all would make every term agree on zero.
 */
const MIN_CORPUS_PER_BIN = 20;

/**
 * An hour must also hold this share of a typical (median) hour to count. The
 * newest hour is still arriving and a quiet night is mostly noise, and a share
 * of 5 posts in 22 swings a correlation as much as a real burst does.
 */
const MIN_BIN_SHARE_OF_MEDIAN = 0.25;

const median = (values: readonly number[]): number => {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};

/** One row as the previous pass left it: a term, its members and its hourly series. */
export interface SynchronyTerm {
  /** The term the row is reported under. */
  term: string;
  /** Every original term the row already stands for, `term` included. */
  members: readonly string[];
  /** Hourly post counts over the window, oldest first. */
  series: readonly number[];
}

/** Posts carrying both of two rows. */
export interface SynchronyPair {
  a: string;
  b: string;
  posts: number;
}

/** A row that absorbed others. */
export interface SynchronyMerge {
  representative: string;
  /** The other rows' terms, as they were named going in. */
  absorbed: string[];
}

export interface SynchronyResult {
  merges: SynchronyMerge[];
  /** The pairs that passed every test and were applied, for the graph. */
  linkedPairs: { a: string; b: string }[];
  /** Pairs that passed every test but would have exceeded `maxStoryTerms`. */
  refusedForSize: string[];
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Pearson correlation of two equal-length series. A flat series has no shape to
 * correlate, so it correlates with nothing (0) rather than producing NaN.
 */
export function pearson(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length < 2) return 0;
  const meanLeft = sum(left.slice(0, length)) / length;
  const meanRight = sum(right.slice(0, length)) / length;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < length; index += 1) {
    const dl = left[index] - meanLeft;
    const dr = right[index] - meanRight;
    covariance += dl * dr;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
  }
  if (varianceLeft === 0 || varianceRight === 0) return 0;
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/**
 * Correlate two terms by their SHARE of each hour's posts, not their counts.
 *
 * Counts all follow the network's own daily rhythm — everything rises in the
 * evening — so two unrelated terms correlate at 0.9+ on counts alone (measured:
 * `trump` against `huang`, 0.97). Dividing by the hour's total posts removes
 * the rhythm and leaves what the term did on top of it.
 */
export function shareCorrelation(
  left: readonly number[],
  right: readonly number[],
  corpus: readonly number[],
): number {
  const a: number[] = [];
  const b: number[] = [];
  const length = Math.min(left.length, right.length, corpus.length);
  const floor = Math.max(MIN_CORPUS_PER_BIN, MIN_BIN_SHARE_OF_MEDIAN * median(corpus));
  for (let index = 0; index < length; index += 1) {
    if (corpus[index] < floor) continue;
    a.push(left[index] / corpus[index]);
    b.push(right[index] / corpus[index]);
  }
  return pearson(a, b);
}

/**
 * How much of a series' volume falls in its busiest `width` consecutive bins:
 * the measure of a burst, wherever in the window it happened. A flat series has
 * `width / length` of it; the names of a live story have most of it.
 */
export function peakShare(series: readonly number[], width: number): number {
  const total = sum(series);
  if (total === 0) return 0;
  let window = sum(series.slice(0, width));
  let best = window;
  for (let index = width; index < series.length; index += 1) {
    window += series[index] - series[index - width];
    best = Math.max(best, window);
  }
  return best / total;
}

/**
 * Merge terms with a clear peak whose series move together and whose posts overlap.
 *
 * `corpus` is the number of posts in each bin, the denominator of a term's share.
 *
 * Links apply STRONGEST FIRST (highest correlation, ties by name) so the result
 * cannot depend on the order the database returned pairs in. The row keeps the
 * name of its busiest member, as clusters do.
 */
export function mergeSynchronizedTerms(
  terms: readonly SynchronyTerm[],
  pairs: readonly SynchronyPair[],
  peakBins: number,
  corpus: readonly number[],
  config: MtnTrendSynchronyConfig,
): SynchronyResult {
  const empty: SynchronyResult = { merges: [], linkedPairs: [], refusedForSize: [] };
  if (!config.enabled || terms.length < 2) return empty;

  const byTerm = new Map(terms.map((row) => [row.term, row]));
  const posts = new Map(terms.map((row) => [row.term, sum(row.series)]));
  const peaked = new Set(
    terms
      .filter((row) => peakShare(row.series, peakBins) >= config.minPeakShare)
      .map((row) => row.term),
  );

  const links: { a: string; b: string; correlation: number }[] = [];
  for (const pair of pairs) {
    if (pair.posts < config.minSharedPosts) continue;
    if (!peaked.has(pair.a) || !peaked.has(pair.b)) continue;
    const rowA = byTerm.get(pair.a);
    const rowB = byTerm.get(pair.b);
    if (!rowA || !rowB) continue;
    const coverage = Math.max(
      pair.posts / (posts.get(pair.a) ?? Infinity),
      pair.posts / (posts.get(pair.b) ?? Infinity),
    );
    if (coverage < config.minCoverage) continue;
    const correlation = shareCorrelation(rowA.series, rowB.series, corpus);
    if (correlation >= config.minSeriesCorrelation) {
      links.push({ a: pair.a, b: pair.b, correlation });
    }
  }
  if (links.length === 0) return empty;

  links.sort(
    (left, right) =>
      right.correlation - left.correlation ||
      `${left.a}+${left.b}`.localeCompare(`${right.a}+${right.b}`),
  );

  // Union-find on rows; `size` counts ORIGINAL terms so the ceiling means what
  // a reader sees, not how many rows happened to be merged along the way.
  const parent = new Map<string, string>();
  const size = new Map(terms.map((row) => [row.term, row.members.length]));
  const find = (term: string): string => {
    let root = term;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    return root;
  };

  const linkedPairs: { a: string; b: string }[] = [];
  const refusedForSize: string[] = [];
  for (const link of links) {
    const rootA = find(link.a);
    const rootB = find(link.b);
    if (rootA === rootB) {
      linkedPairs.push({ a: link.a, b: link.b });
      continue;
    }
    if ((size.get(rootA) ?? 1) + (size.get(rootB) ?? 1) > config.maxStoryTerms) {
      refusedForSize.push(`${link.a}+${link.b}`);
      continue;
    }
    const busier =
      (posts.get(rootA) ?? 0) > (posts.get(rootB) ?? 0) ||
      ((posts.get(rootA) ?? 0) === (posts.get(rootB) ?? 0) && rootA < rootB);
    const [keep, absorb] = busier ? [rootA, rootB] : [rootB, rootA];
    parent.set(absorb, keep);
    size.set(keep, (size.get(keep) ?? 1) + (size.get(absorb) ?? 1));
    // The merged row's busiest member decides later merges too.
    posts.set(keep, Math.max(posts.get(keep) ?? 0, posts.get(absorb) ?? 0));
    linkedPairs.push({ a: link.a, b: link.b });
  }

  const absorbedBy = new Map<string, string[]>();
  for (const row of terms) {
    const root = find(row.term);
    if (root === row.term) continue;
    const list = absorbedBy.get(root);
    if (list) list.push(row.term);
    else absorbedBy.set(root, [row.term]);
  }
  const merges = [...absorbedBy]
    .map(([representative, absorbed]) => ({ representative, absorbed: absorbed.sort() }))
    .sort((left, right) => left.representative.localeCompare(right.representative));

  return { merges, linkedPairs, refusedForSize };
}
