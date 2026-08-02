import mongoose, { Schema, type Document } from 'mongoose';

/**
 * One batch's CO-OCCURRENCE GRAPH — the structure behind the trend list.
 *
 * The detector already measures which terms appear in the same posts and which
 * of them are one story. Until now that measurement lived only in memory for the
 * length of a batch, which made the most interesting question about the list
 * unanswerable after the fact: not "what is trending" but "why did these two end
 * up together, and why did those two not". This is that measurement, kept.
 *
 * Stored as ONE document per batch rather than a row per edge. A graph is a
 * snapshot — its nodes and edges are only meaningful against each other and
 * against the batch that produced them — so the batch is the natural unit: one
 * insert, one read, and no way to serve half of one graph and half of another.
 *
 * NORMALIZED against `Trending`: nodes carry structure only (volume, authors,
 * languages, regions, which story they were merged into). A node's display
 * label is NOT stored here — merged rows already have one on their `Trending`
 * document, and the read path joins them. Copying it would create a second
 * place for a label to be wrong, and most nodes are not trends at all and have
 * no label to copy.
 */
export interface TrendGraphNode {
  /** The term. Lowercase, possibly a phrase — the same key `Trending.name` uses. */
  term: string;
  /** Posts carrying the term in the window. */
  volume: number;
  /** DISTINCT authors of those posts — the number that tells agreement from repetition. */
  authorCount: number;
  /** Primary languages of those posts (ISO 639-1). */
  languages: string[];
  /**
   * Coarse regions of those posts, where known.
   *
   * `postClassification.region` is sparse by design, so this is frequently
   * empty. That is reported rather than hidden: a region filter built from the
   * data offers exactly the regions the data has.
   */
  regions: string[];
  /**
   * The term this node was merged into, when clustering merged it.
   *
   * Absent for a term that stands alone. Present and equal to `term` for the
   * representative of a story, so a client can find a story's centre without
   * having to compare volumes itself.
   */
  story?: string;
}

export interface TrendGraphEdge {
  /** The lexicographically smaller term. Pairs are unordered and stored once. */
  a: string;
  /** The larger term. */
  b: string;
  /** Posts containing BOTH. */
  posts: number;
  /**
   * Whether the clusterer joined these two.
   *
   * The near-misses are the point of keeping edges at all: an edge that exists
   * and did not merge is the visible answer to "why are these still two rows".
   * Deliberately NOT a stored ratio — both directional ratios are `posts`
   * divided by a node's own `volume`, which is already here, and a stored
   * derivative is one more thing that can disagree with its source.
   */
  linked: boolean;
}

export interface ITrendGraph extends Document {
  calculatedAt: Date;
  nodes: TrendGraphNode[];
  edges: TrendGraphEdge[];
  /**
   * Edges dropped for size, if any.
   *
   * A cap that is not reported reads as "this is the whole graph" when it is
   * not — the same reason a refused cluster merge is logged.
   */
  droppedEdges?: number;
}

/** 7 days. Long enough to compare a few days of batches, short enough to stay small. */
export const TREND_GRAPH_TTL_SECONDS = 7 * 24 * 60 * 60;

const TrendGraphNodeSchema = new Schema<TrendGraphNode>(
  {
    term: { type: String, required: true },
    volume: { type: Number, required: true },
    authorCount: { type: Number, required: true },
    languages: { type: [String], default: [] },
    regions: { type: [String], default: [] },
    story: { type: String },
  },
  { _id: false },
);

const TrendGraphEdgeSchema = new Schema<TrendGraphEdge>(
  {
    a: { type: String, required: true },
    b: { type: String, required: true },
    posts: { type: Number, required: true },
    linked: { type: Boolean, required: true },
  },
  { _id: false },
);

const TrendGraphSchema = new Schema<ITrendGraph>({
  calculatedAt: { type: Date, required: true },
  nodes: { type: [TrendGraphNodeSchema], default: [] },
  edges: { type: [TrendGraphEdgeSchema], default: [] },
  droppedEdges: { type: Number },
});

// One graph per batch. Unique so a retried batch cannot leave two.
TrendGraphSchema.index({ calculatedAt: -1 }, { unique: true });
TrendGraphSchema.index({ calculatedAt: 1 }, { expireAfterSeconds: TREND_GRAPH_TTL_SECONDS });

export default mongoose.model<ITrendGraph>('TrendGraph', TrendGraphSchema);
