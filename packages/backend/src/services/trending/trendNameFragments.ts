/**
 * Join a name fragment to the fuller name it belongs to.
 *
 * People write `Mason` about `Chris Mason`, `Hegseth` about `Pete Hegseth`,
 * `Foxx` about `Virginia Foxx`. For a small story the two spellings share a
 * handful of posts, far too few for co-occurrence ratios or hourly series to
 * mean anything — yet the relation is not a statistical guess: one name is
 * literally a part of the other, and both are being written about in the same
 * window.
 *
 * That relation alone is not enough, and the guards are the whole design:
 *  - a fragment joins ONE fuller name, the one it actually shares the most posts
 *    with, and only when that is clearly the winner. `Huang` belongs to
 *    `Jensen Huang`, not also to `Alice Huang`; attaching it to both would fuse
 *    two unrelated people through it, and a fragment split evenly between two
 *    names (`Carolina`) belongs to neither;
 *  - the fragment must not dwarf the fuller name (`house` is far bigger than
 *    `white house`: it is a word with many uses, not a short form);
 *  - a real share of the fuller name's posts must also carry the fragment. A
 *    generic word sits inside many names and shares a sliver of each
 *    (`board` in `nvidia board`, 9%); a real short form shares a large part.
 *
 * Pure and storage-free, like `trendClustering`: it takes counts and returns
 * links. Reading the shared-post counts is `trendDetection`'s job.
 */

import type { MtnTrendNameFragmentConfig } from '@mention/shared-types';
import type { TrendTermPair } from './trendClustering';

/** A term and how many posts carry it. */
export interface NameFragmentCandidate {
  term: string;
  volume: number;
}

/** A fragment and a fuller name that contains it as a run of whole words. */
export interface NameFragmentRelation {
  fragment: string;
  container: string;
}

const tokensOf = (term: string): string[] => term.split(' ');

/** Whether `fragment`'s words appear, in order and adjacent, inside `container`'s. */
function isRunOf(fragment: readonly string[], container: readonly string[]): boolean {
  if (fragment.length >= container.length) return false;
  for (let start = 0; start + fragment.length <= container.length; start += 1) {
    if (fragment.every((word, offset) => container[start + offset] === word)) return true;
  }
  return false;
}

/**
 * Every (fragment, fuller name) pair among the candidates that passes the size
 * guard. Words are compared whole, so `us` is never "inside" `justice`.
 *
 * Indexed by word so the work follows the number of related pairs rather than
 * the square of the vocabulary.
 */
export function findNameFragmentRelations(
  candidates: readonly NameFragmentCandidate[],
  config: MtnTrendNameFragmentConfig,
): NameFragmentRelation[] {
  if (!config.enabled) return [];

  const volumeOf = new Map(candidates.map((candidate) => [candidate.term, candidate.volume]));
  const byFirstWord = new Map<string, string[]>();
  for (const { term } of candidates) {
    const first = tokensOf(term)[0];
    const list = byFirstWord.get(first);
    if (list) list.push(term);
    else byFirstWord.set(first, [term]);
  }

  // A fragment can start at any word of its container, so the containers are
  // indexed by EVERY word they hold and a fragment is looked up by its first.
  const containersByWord = new Map<string, string[]>();
  for (const { term } of candidates) {
    const words = tokensOf(term);
    if (words.length < 2) continue;
    for (const word of new Set(words)) {
      const list = containersByWord.get(word);
      if (list) list.push(term);
      else containersByWord.set(word, [term]);
    }
  }

  const relations: NameFragmentRelation[] = [];
  for (const { term: fragment, volume } of candidates) {
    const fragmentWords = tokensOf(fragment);
    for (const container of containersByWord.get(fragmentWords[0]) ?? []) {
      if (container === fragment) continue;
      if (!isRunOf(fragmentWords, tokensOf(container))) continue;
      const containerVolume = volumeOf.get(container) ?? 0;
      if (containerVolume > 0 && volume <= containerVolume * config.maxVolumeRatio) {
        relations.push({ fragment, container });
      }
    }
  }
  return relations;
}

/**
 * The links to apply: each fragment attached to the single fuller name it
 * shares the most posts with, provided that share is real and unambiguous.
 *
 * A fragment with two fuller names of comparable evidence (`korea` between
 * `south korea` and `north korea`, `carolina` between the two Carolinas) is a
 * short form of neither as far as the posts can tell, so it joins neither: the
 * winner must hold at least `ambiguityRatio` times the posts of the runner-up.
 * Ties break by the larger fuller name, then lexicographically, so the result
 * cannot depend on iteration order.
 */
export function buildNameFragmentPairs(
  relations: readonly NameFragmentRelation[],
  sharedPosts: ReadonlyMap<string, number>,
  volumeOf: ReadonlyMap<string, number>,
  config: MtnTrendNameFragmentConfig,
): TrendTermPair[] {
  const byFragment = new Map<string, { container: string; posts: number }[]>();
  for (const { fragment, container } of relations) {
    const posts = sharedPosts.get(relationKey(fragment, container)) ?? 0;
    const list = byFragment.get(fragment);
    if (list) list.push({ container, posts });
    else byFragment.set(fragment, [{ container, posts }]);
  }

  const pairs: TrendTermPair[] = [];
  for (const [fragment, options] of byFragment) {
    options.sort(
      (left, right) =>
        right.posts - left.posts ||
        (volumeOf.get(right.container) ?? 0) - (volumeOf.get(left.container) ?? 0) ||
        left.container.localeCompare(right.container),
    );
    const [winner, runnerUp] = options;
    const containerVolume = volumeOf.get(winner.container) ?? 0;
    if (winner.posts < config.minSharedPosts || containerVolume <= 0) continue;
    if (winner.posts / containerVolume < config.minContainerShare) continue;
    if (runnerUp && winner.posts < runnerUp.posts * config.ambiguityRatio) continue;
    pairs.push({ a: fragment, b: winner.container, posts: winner.posts, reason: 'name-fragment' });
  }
  return pairs.sort((left, right) => `${left.a}+${left.b}`.localeCompare(`${right.a}+${right.b}`));
}

/** The key under which a (fragment, fuller name) pair's shared-post count is stored. */
export function relationKey(fragment: string, container: string): string {
  return `${fragment}\u0000${container}`;
}
