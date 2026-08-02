/**
 * Group the terms of ONE story into one row, from co-occurrence alone.
 *
 * A story does not arrive as a word. It arrives as several names at once —
 * `Ukraine`, `Zelensky`, `Kyiv`, `Russia` — which the detector sees as four
 * unrelated candidates competing for four slots, each carrying a quarter of the
 * evidence. That split is not only ugly on the screen: the burst statistic is a
 * rate compared against its own baseline, so quartering the rate is a reliable
 * way to make a real event clear no bar at all.
 *
 * The whole input is how often two terms appear in the SAME post. Nothing here
 * knows what a word means, which is the point: a synonym table would have to be
 * written in advance, in every language the network speaks, for stories that
 * have not happened yet — and the name at the centre of next week's story is
 * precisely the one no list contains. Co-occurrence is a fact the posts already
 * carry.
 *
 * Pure and storage-free, like `termExtraction`: it takes counts and returns
 * groupings. Everything about windows, pipelines and Mongo lives in
 * `TrendingService`.
 */

import type { MtnTrendClusteringConfig } from '@mention/shared-types';

/** Two terms and the number of posts that contain both. */
export interface TrendTermPair {
  a: string;
  b: string;
  posts: number;
}

/** A candidate as this module needs it: a term and how many posts carry it. */
export interface TrendClusterCandidate {
  term: string;
  volume: number;
}

/** One story: the term that names it, and every term merged into it. */
export interface TrendCluster {
  /** The term the row is reported under — the highest-volume member. */
  representative: string;
  /** Every member, representative first. Always at least two. */
  members: string[];
}

/** What {@link clusterTrendTerms} found, including what it refused. */
export interface TrendClusterResult {
  clusters: TrendCluster[];
  /**
   * Merges declined because they would have exceeded `maxClusterSize`, as
   * `a+b` pairs.
   *
   * Reported rather than dropped: a refused merge silently leaves a story split
   * across rows, which looks exactly like clustering never being asked to run.
   * The caller logs these, so a ceiling that is too tight is visible as itself.
   */
  refusedForSize: string[];
}

/**
 * Whether two terms belong to the same story.
 *
 * Two directional ratios: of the posts carrying `a`, the share that also carry
 * `b`, and the reverse. The STRONG side is the larger — a subordinate name like
 * `Kyiv` is rarely written without the story it belongs to. The WEAK side is
 * the smaller, and requiring it too is what stops a niche term being absorbed
 * by whatever broad term it happens to accompany: a one-directional test merges
 * every small term into the biggest thing it ever appears beside, and fuses two
 * unrelated stories the moment they share one word.
 */
function isLinked(
  pair: TrendTermPair,
  volumeOf: ReadonlyMap<string, number>,
  config: MtnTrendClusteringConfig,
): boolean {
  if (pair.posts < config.minPairPosts) return false;

  const volumeA = volumeOf.get(pair.a) ?? 0;
  const volumeB = volumeOf.get(pair.b) ?? 0;
  if (volumeA <= 0 || volumeB <= 0) return false;

  const ratioA = pair.posts / volumeA;
  const ratioB = pair.posts / volumeB;
  return (
    Math.max(ratioA, ratioB) >= config.strongLinkRatio &&
    Math.min(ratioA, ratioB) >= config.weakLinkRatio
  );
}

/**
 * Merge co-occurring candidate terms into stories.
 *
 * Links are applied STRONGEST FIRST so the result cannot depend on the order
 * Mongo happened to return pairs in — a batch that reorders its rows must not
 * produce different trends. Ties break lexicographically for the same reason.
 *
 * Terms in no cluster are absent from the result; the caller keeps reporting
 * them exactly as before. Clustering only ever joins rows, never removes one.
 */
export function clusterTrendTerms(
  candidates: readonly TrendClusterCandidate[],
  pairs: readonly TrendTermPair[],
  config: MtnTrendClusteringConfig,
): TrendClusterResult {
  if (!config.enabled || candidates.length === 0) return { clusters: [], refusedForSize: [] };

  const volumeOf = new Map(candidates.map((candidate) => [candidate.term, candidate.volume]));

  const linked = pairs
    .filter((pair) => volumeOf.has(pair.a) && volumeOf.has(pair.b))
    .filter((pair) => isLinked(pair, volumeOf, config))
    .sort((left, right) => {
      if (right.posts !== left.posts) return right.posts - left.posts;
      return `${left.a}+${left.b}`.localeCompare(`${right.a}+${right.b}`);
    });

  // Union-find. `parent` maps a term to its group; `size` is kept on roots only.
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  const find = (term: string): string => {
    let root = parent.get(term) ?? term;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    // Path compression, so a long chain does not make later lookups quadratic.
    let cursor = term;
    while (cursor !== root) {
      const next = parent.get(cursor) ?? cursor;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const refusedForSize: string[] = [];
  for (const pair of linked) {
    const rootA = find(pair.a);
    const rootB = find(pair.b);
    if (rootA === rootB) continue;

    const merged = (size.get(rootA) ?? 1) + (size.get(rootB) ?? 1);
    if (merged > config.maxClusterSize) {
      // Merging is transitive, so a chain of individually reasonable links can
      // walk one row across unrelated stories. Past the ceiling the evidence is
      // that the links are too loose, not that the story is that large.
      refusedForSize.push(`${pair.a}+${pair.b}`);
      continue;
    }

    // Attach the smaller group under the larger; ties by term so the shape is
    // decided by the data rather than by iteration order.
    const [keep, absorb] =
      (size.get(rootA) ?? 1) > (size.get(rootB) ?? 1) ||
      ((size.get(rootA) ?? 1) === (size.get(rootB) ?? 1) && rootA < rootB)
        ? [rootA, rootB]
        : [rootB, rootA];
    parent.set(absorb, keep);
    size.set(keep, merged);
    size.delete(absorb);
  }

  const byRoot = new Map<string, string[]>();
  for (const candidate of candidates) {
    const root = find(candidate.term);
    const members = byRoot.get(root);
    if (members) members.push(candidate.term);
    else byRoot.set(root, [candidate.term]);
  }

  const clusters: TrendCluster[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    // The row is reported under its biggest member — the name most of the
    // conversation already uses. Never an invented umbrella like "War": that
    // needs a taxonomy written by hand, which is the thing being avoided.
    //
    // Ties go to the LONGER phrase, because the commonest tie is a name and its
    // own fragments. One person produced four candidates at volume 4 in the
    // live window — `luis`, `sampedro`, `jose luis`, `luis sampedro` — since a
    // phrase and every word inside it are counted over the same posts. Equal
    // evidence for all of them means volume cannot choose, and alphabetical
    // order would have named that row `jose luis`. The more specific phrase is
    // the better name for the same evidence. Lexicographic order remains the
    // last resort, so the result stays independent of input order.
    const ordered = [...members].sort((left, right) => {
      const byVolume = (volumeOf.get(right) ?? 0) - (volumeOf.get(left) ?? 0);
      if (byVolume !== 0) return byVolume;
      const byTokens = right.split(' ').length - left.split(' ').length;
      return byTokens !== 0 ? byTokens : left.localeCompare(right);
    });
    clusters.push({ representative: ordered[0], members: ordered });
  }

  // Deterministic output order, so two batches over identical data write
  // identical documents.
  clusters.sort((left, right) => left.representative.localeCompare(right.representative));
  return { clusters, refusedForSize };
}

/**
 * Every member term mapped to the term its row is reported under.
 *
 * The representative maps to itself, so a caller can look up any term without
 * first asking whether it is one.
 */
export function buildClusterMap(clusters: readonly TrendCluster[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cluster of clusters) {
    for (const member of cluster.members) map.set(member, cluster.representative);
  }
  return map;
}
