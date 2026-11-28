import type { TrendGraphEdgeDTO, TrendGraphNodeDTO } from '@mention/shared-types';

/**
 * Turn the co-occurrence graph into the TREE it actually contains.
 *
 * The measurement itself is symmetric — it can say two terms belong together,
 * never that one is a kind of the other — so a hierarchy invented from edge
 * weights would be a claim the data does not make. But the clusterer produces a
 * directed relation on top of it and that one is real: every story has a
 * REPRESENTATIVE, the term the row is reported under, and the terms merged into
 * it. Parent and child here mean exactly that and nothing more.
 *
 * Three levels, each a fact rather than a rendering choice:
 *
 *   story (the representative)
 *   └─ member (a term merged into it)
 *      └─ related (a term that shares posts and was NOT merged)
 *
 * The third level is the interesting one. An unmerged edge is the visible answer
 * to why two terms are still two rows, so it hangs off the term it failed to
 * join rather than being dropped for not fitting the shape.
 */

/** A term that shares posts with this one but was not merged into it. */
export interface TrendTreeRelation {
  term: string;
  displayName?: string;
  /** Posts containing both. */
  posts: number;
}

export interface TrendTreeNode {
  node: TrendGraphNodeDTO;
  /** Terms merged into this one. Empty for a term that stands alone. */
  children: TrendTreeNode[];
  /** Edges from this term that did NOT merge. */
  related: TrendTreeRelation[];
}

export interface TrendTree {
  /** Merged stories, largest first. Each root is a representative. */
  stories: TrendTreeNode[];
  /** Terms in no story, largest first. */
  ungrouped: TrendTreeNode[];
}

/** Volume descending, then term, so equal rows do not reorder between renders. */
function byVolume(left: TrendGraphNodeDTO, right: TrendGraphNodeDTO): number {
  const difference = right.volume - left.volume;
  return difference !== 0 ? difference : left.term.localeCompare(right.term);
}

export function buildTrendTree(
  nodes: readonly TrendGraphNodeDTO[],
  edges: readonly TrendGraphEdgeDTO[],
): TrendTree {
  const labels = new Map(nodes.map((node) => [node.term, node.displayName]));

  // Unmerged edges only, indexed by each endpoint: a near miss belongs under
  // BOTH terms it failed to join, since it explains each of them.
  const relations = new Map<string, TrendTreeRelation[]>();
  for (const edge of edges) {
    if (edge.linked) continue;
    for (const [from, to] of [
      [edge.a, edge.b],
      [edge.b, edge.a],
    ]) {
      const list = relations.get(from) ?? [];
      const displayName = labels.get(to);
      list.push({ term: to, posts: edge.posts, ...(displayName ? { displayName } : {}) });
      relations.set(from, list);
    }
  }

  const leaf = (node: TrendGraphNodeDTO): TrendTreeNode => ({
    node,
    children: [],
    related: (relations.get(node.term) ?? []).sort(
      (left, right) => right.posts - left.posts || left.term.localeCompare(right.term),
    ),
  });

  const stories: TrendTreeNode[] = [];
  const ungrouped: TrendTreeNode[] = [];
  const membersOf = new Map<string, TrendGraphNodeDTO[]>();

  for (const node of nodes) {
    // A representative points at itself, which is what makes it the root; a
    // node with no story is not part of one at all.
    if (!node.story) continue;
    if (node.story === node.term) continue;
    const list = membersOf.get(node.story) ?? [];
    list.push(node);
    membersOf.set(node.story, list);
  }

  for (const node of [...nodes].sort(byVolume)) {
    if (node.story === node.term) {
      stories.push({
        ...leaf(node),
        children: (membersOf.get(node.term) ?? []).sort(byVolume).map(leaf),
      });
    } else if (!node.story) {
      ungrouped.push(leaf(node));
    }
    // A member is reached through its story and is deliberately not repeated at
    // the top level: one term, one place in the tree.
  }

  return { stories, ungrouped };
}
