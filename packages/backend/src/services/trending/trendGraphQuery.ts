/**
 * Read one batch's co-occurrence graph, scoped to a language or a region.
 *
 * Separate from `trendGraph.ts`, which writes it. The filtering rules are the
 * whole of this module and they are pure, so the one thing worth getting right
 * — that a filtered graph stays internally consistent — can be tested without a
 * database.
 */

import type { TrendGraphEdgeDTO, TrendGraphNodeDTO, TrendGraphResponse } from '@mention/shared-types';
import { getBaseLanguage } from '@oxyhq/core';
import TrendGraph from '../../models/TrendGraph';
import Trending from '../../models/Trending';
import { logger } from '../../utils/logger';

export interface TrendGraphFilters {
  /** BCP-47 or ISO 639-1; compared on the base subtag, as ranking does. */
  language?: string;
  /** Coarse region code, compared case-insensitively. */
  region?: string;
}

/**
 * Keep the nodes a filter admits, then keep only edges whose BOTH endpoints
 * survived.
 *
 * An edge to a node that is no longer there is not a weaker edge, it is a
 * dangling reference: it would draw a line to nothing, and any ratio computed
 * from it would divide by a volume the client cannot see. So the node filter is
 * the only filter, and edges follow from it.
 */
export function applyGraphFilters(
  nodes: readonly TrendGraphNodeDTO[],
  edges: readonly TrendGraphEdgeDTO[],
  filters: TrendGraphFilters,
): { nodes: TrendGraphNodeDTO[]; edges: TrendGraphEdgeDTO[] } {
  const language = filters.language ? getBaseLanguage(filters.language) : undefined;
  const region = filters.region?.toLowerCase();

  const keptNodes = nodes.filter((node) => {
    // An unmeasured axis never excludes. A term whose posts carry no resolved
    // region is not evidence that it belongs to a different one, and dropping it
    // would make the filter quietly mean "terms we happen to have region data
    // for" — which is most of the graph missing, given how sparse that field is.
    if (language && node.languages.length > 0) {
      if (!node.languages.some((code) => getBaseLanguage(code) === language)) return false;
    }
    if (region && node.regions.length > 0) {
      if (!node.regions.some((code) => code.toLowerCase() === region)) return false;
    }
    return true;
  });

  const kept = new Set(keptNodes.map((node) => node.term));
  return {
    nodes: keptNodes,
    edges: edges.filter((edge) => kept.has(edge.a) && kept.has(edge.b)),
  };
}

/** Every distinct value of one axis across the UNFILTERED graph, sorted. */
function axisValues(
  nodes: readonly TrendGraphNodeDTO[],
  pick: (node: TrendGraphNodeDTO) => string[],
): string[] {
  const values = new Set<string>();
  for (const node of nodes) for (const value of pick(node)) values.add(value);
  return [...values].sort();
}

/**
 * The newest graph, labelled and filtered.
 *
 * Labels are joined from the same batch's `Trending` rows rather than stored on
 * the graph: a merged row already has a derived `displayName`, and most nodes
 * are not trends and have none. One place for a label means it cannot be wrong
 * in two.
 *
 * Returns `null` when no batch has produced a graph yet, which is a real state
 * on a fresh instance and on one where clustering is switched off.
 */
export async function loadTrendGraph(
  filters: TrendGraphFilters,
): Promise<TrendGraphResponse | null> {
  const graph = await TrendGraph.findOne()
    .sort({ calculatedAt: -1 })
    .maxTimeMS(2000)
    .lean<{
      calculatedAt: Date;
      nodes: TrendGraphNodeDTO[];
      edges: TrendGraphEdgeDTO[];
      droppedEdges?: number;
    } | null>();

  if (!graph) return null;

  const labels = await loadLabels(graph.calculatedAt);
  const labelled: TrendGraphNodeDTO[] = graph.nodes.map((node) => {
    const displayName = labels.get(node.term);
    return {
      term: node.term,
      volume: node.volume,
      authorCount: node.authorCount,
      languages: node.languages ?? [],
      regions: node.regions ?? [],
      ...(node.story ? { story: node.story } : {}),
      ...(displayName ? { displayName } : {}),
    };
  });

  const filtered = applyGraphFilters(labelled, graph.edges ?? [], filters);

  return {
    calculatedAt: graph.calculatedAt.toISOString(),
    nodes: filtered.nodes,
    edges: filtered.edges,
    // Taken from the UNFILTERED graph on purpose: a filter list that shrank as
    // you used it would strand a reader in a selection they cannot leave.
    availableLanguages: axisValues(labelled, (node) => node.languages),
    availableRegions: axisValues(labelled, (node) => node.regions),
    ...(graph.droppedEdges ? { droppedEdges: graph.droppedEdges } : {}),
  };
}

/**
 * Display labels for the terms of one batch.
 *
 * Fail-soft: without labels every node shows its term, which is what a node
 * that never became a trend shows anyway.
 */
async function loadLabels(calculatedAt: Date): Promise<Map<string, string>> {
  try {
    const rows = await Trending.find({ calculatedAt })
      .select({ name: 1, displayName: 1 })
      .maxTimeMS(1000)
      .lean<{ name: string; displayName?: string }[]>();

    const labels = new Map<string, string>();
    for (const row of rows) if (row.displayName) labels.set(row.name, row.displayName);
    return labels;
  } catch (error) {
    logger.warn('[Trending] Graph labels unavailable; nodes show their terms', { error });
    return new Map();
  }
}
