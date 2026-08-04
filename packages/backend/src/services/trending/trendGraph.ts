/**
 * Turn a batch's measurements into the graph behind the trend list, and keep it.
 *
 * The detector already knows which terms share posts and which of them it
 * merged. Discarding that at the end of every batch made the most useful
 * question about a list unanswerable: not "what is trending" but "why are these
 * two one row, and why are those two still two". This is that answer, written
 * down.
 *
 * Building is PURE and separate from saving, so the shape can be tested without
 * a database and the write stays a single, obviously-fail-soft call.
 */

import { getDb } from '../../db/postgres';
import { trendGraphs, type StoredTrendGraphNode } from '../../db/schema/discovery';
import { logger } from '../../utils/logger';
import type { TrendGraphEdgeDTO } from '@mention/shared-types';
import type { TrendTermPair } from './trendClustering';

/**
 * What a node needs, expressed here rather than imported from the service.
 *
 * The service's `TermCandidate` carries ranking machinery this module has no
 * business knowing about; naming the four fields keeps the dependency pointing
 * one way.
 */
export interface TrendGraphNodeInput {
  term: string;
  volume: number;
  authorCount: number;
  languages: string[];
  regions: string[];
}

export interface TrendGraphSnapshot {
  calculatedAt: Date;
  nodes: StoredTrendGraphNode[];
  edges: TrendGraphEdgeDTO[];
  droppedEdges?: number;
}

/**
 * Ceilings, so one pathological batch cannot write a document nothing can load.
 *
 * Both are far above anything measured (a live batch produced 45 terms at a
 * volume floor of 2), and what they drop is REPORTED — a silent cap reads as
 * "this is the whole graph" when it is not.
 */
const MAX_NODES = 300;
const MAX_EDGES = 800;

/**
 * Assemble the graph.
 *
 * Nodes come from the per-term measurements, never from merged rows: an edge's
 * two ratios are its post count over each endpoint's OWN volume, and a merged
 * row reports the story's total instead. Mixing them would draw links that do
 * not follow from the numbers shown beside them.
 */
export function buildTrendGraph(
  calculatedAt: Date,
  candidates: readonly TrendGraphNodeInput[],
  pairs: readonly TrendTermPair[],
  linkedPairs: readonly { a: string; b: string }[],
  aliases: ReadonlyMap<string, string>,
): TrendGraphSnapshot {
  const ranked = [...candidates].sort((left, right) => {
    const byVolume = right.volume - left.volume;
    return byVolume !== 0 ? byVolume : left.term.localeCompare(right.term);
  });
  const kept = ranked.slice(0, MAX_NODES);
  const keptTerms = new Set(kept.map((candidate) => candidate.term));

  const nodes: StoredTrendGraphNode[] = kept.map((candidate) => ({
    term: candidate.term,
    volume: candidate.volume,
    authorCount: candidate.authorCount,
    languages: candidate.languages,
    regions: candidate.regions,
    ...(aliases.has(candidate.term) ? { story: aliases.get(candidate.term) } : {}),
  }));

  const linked = new Set(linkedPairs.map((pair) => edgeKey(pair.a, pair.b)));
  const candidateEdges = pairs
    // An edge to a node that was cut has nothing to connect to. Dropping it here
    // rather than at render time keeps the stored graph internally consistent.
    .filter((pair) => keptTerms.has(pair.a) && keptTerms.has(pair.b))
    .sort((left, right) => {
      const byPosts = right.posts - left.posts;
      return byPosts !== 0 ? byPosts : edgeKey(left.a, left.b).localeCompare(edgeKey(right.a, right.b));
    });

  const edges: TrendGraphEdgeDTO[] = candidateEdges.slice(0, MAX_EDGES).map((pair) => {
    const [a, b] = pair.a <= pair.b ? [pair.a, pair.b] : [pair.b, pair.a];
    return { a, b, posts: pair.posts, linked: linked.has(edgeKey(pair.a, pair.b)) };
  });

  // Counted against the INPUT, not against what survived the node cut: an edge
  // whose endpoint was removed is just as absent from the picture as one over
  // the cap, and reporting only the second would understate the truncation
  // exactly when the node ceiling is what bit.
  const droppedEdges = pairs.length - edges.length;
  return {
    calculatedAt,
    nodes,
    edges,
    ...(droppedEdges > 0 ? { droppedEdges } : {}),
  };
}

/**
 * Unordered pair key, so `a+b` and `b+a` are one edge.
 *
 * The separator is written as the ESCAPE `\u0000`, never as a raw NUL byte. A
 * raw one makes the file BINARY to grep — which then reports NO MATCH for
 * patterns that are present rather than erroring, so any later audit or
 * mutation test over this file silently reads as clean. `src/__tests__/db/
 * sourceControlCharacters.test.ts` is the gate.
 */
function edgeKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Persist one batch's graph.
 *
 * Fail-soft and deliberately so: the graph is an explanation of the list, not
 * the list. A batch that produced good trends must not be failed because the
 * picture of it could not be written. Idempotent on `calculatedAt`, so a
 * retried batch replaces its own graph rather than colliding with it.
 */
export async function saveTrendGraph(graph: TrendGraphSnapshot | null): Promise<void> {
  if (!graph) return;

  try {
    // `onConflictDoUpdate` on `calculated_at`, which is the table's UNIQUE key
    // and the batch's identity — the direct analogue of the Mongo upsert, and
    // what makes a retried batch replace its own graph rather than collide with
    // it. `dropped_edges` is set on BOTH paths, including back to NULL when a
    // retry truncated nothing: leaving the previous value would say the stored
    // graph is incomplete when it is now whole.
    await getDb()
      .insert(trendGraphs)
      .values({
        calculatedAt: graph.calculatedAt,
        nodes: graph.nodes,
        edges: graph.edges,
        droppedEdges: graph.droppedEdges ?? null,
      })
      .onConflictDoUpdate({
        target: trendGraphs.calculatedAt,
        set: {
          nodes: graph.nodes,
          edges: graph.edges,
          droppedEdges: graph.droppedEdges ?? null,
        },
      });
    if (graph.droppedEdges) {
      logger.info('[Trending] Graph edges truncated', {
        kept: graph.edges.length,
        dropped: graph.droppedEdges,
      });
    }
  } catch (error) {
    logger.warn('[Trending] Could not store the co-occurrence graph', { error });
  }
}
