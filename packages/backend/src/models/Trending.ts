import mongoose, { Document, Schema } from "mongoose";
import { TREND_CATEGORIES } from "@mention/shared-types";
import type { TrendCategory, TrendStatus } from "@mention/shared-types";

export enum TrendingType {
  HASHTAG = 'hashtag',
  TOPIC = 'topic',
  ENTITY = 'entity',
}

/**
 * Retention window for trending rows, in seconds (90 days).
 *
 * The trending job inserts a full batch every 30 minutes, so the `Trending`
 * collection would grow without bound. A TTL index on `calculatedAt` (declared
 * below) reaps rows older than this window at the storage layer, keeping the
 * collection — and therefore every history scan — small. The value is exported
 * so the history aggregation in `TrendingService` can key its query window off
 * the SAME retention bound (the query window must never exceed what is retained).
 */
export const TRENDING_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * The STORED shape of a trending row, free of Mongoose's document surface.
 *
 * Every read path in `TrendingService` is `.lean()` or an aggregation, both of
 * which hand back plain objects. Typing those as `ITrending` — a `Document`, with
 * `save()` and forty-odd other methods on it — was a fiction that held only
 * because nothing ever tried to construct one. Attaching a volume series to a row
 * does construct one, so the plain shape is named here and the document type is
 * derived from it, rather than the other way around.
 */
export interface TrendingRecord {
  _id: mongoose.Types.ObjectId;
  type: TrendingType;
  /**
   * The TERM — the retrieval key. Lowercase, possibly a phrase, and what the
   * `trend|<name>` feed matches posts against. Not for display: see
   * {@link TrendingRecord.displayName}.
   */
  name: string;
  /**
   * Every term this row stands for, {@link TrendingRecord.name} first.
   *
   * A story arrives as several names at once, and co-occurrence merges them into
   * one row — so the row's feed has to match all of them. Without this the
   * merge would be actively harmful: `Ukraine` would absorb `Kyiv`'s evidence
   * into its score and then open onto a screen missing every post that only
   * said `Kyiv`.
   *
   * OPTIONAL for the same reason `displayName` is: 90 days of rows predate
   * clustering. Readers fall back to `[name]`, which is what an unmerged row
   * means anyway.
   */
  terms?: string[];
  /**
   * What a reader is shown ("Kremer Trade" for the term `orioles`).
   *
   * OPTIONAL only because the collection retains 90 days of rows written before
   * trends had labels; every row written from now on carries one (the schema
   * requires it). Readers fall back to `name` — which is exactly the old
   * behaviour for an old row, and never a fabricated label.
   */
  displayName?: string;
  /** Coarse taxonomy hint shown under the label. Absent on pre-label rows. */
  category?: TrendCategory;
  /**
   * The primary languages of the posts behind this term (ISO 639-1).
   *
   * A trend is not language-neutral — `noticia` is a Spanish story and reading
   * it in an Italian list is noise — so the languages travel with the row and
   * the reader's own are matched against them. Absent on rows written before
   * trending measured language, which simply match every reader.
   */
  languages?: string[];
  /**
   * Which labelling rules produced {@link displayName}. A label from older rules
   * is re-derived rather than carried forward for the rest of the run.
   */
  labelVersion?: number;
  description: string;
  score: number;
  /** Posts carrying the term in the trailing window. */
  volume: number;
  /**
   * DISTINCT authors behind those posts. Stored alongside `volume` because it,
   * not the post count, is what the reporting floor is applied to — keeping it
   * makes a stored row explain why it qualified.
   */
  authorCount?: number;
  /**
   * How far above its own baseline the term landed, in standard deviations —
   * the actual trend measurement (`score` only orders it). Absent on rows
   * written before detection became a burst statistic.
   */
  burstScore?: number;
  momentum: number;
  /**
   * When the CURRENT run of this trend began — reconstructed from the batches it
   * has appeared in, not from when this row was written. Drives the client's
   * `new` badge and its age label. Absent on pre-onset rows.
   */
  startedAt?: Date;
  /** Present only while the trend is bursting hard enough to be called out. */
  status?: TrendStatus;
  /**
   * A few of the accounts behind the trend, for the faces shown beside it.
   * Evidence that real people are posting, not a directory — capped at
   * `MtnConfig.trending.detection.maxActors`.
   */
  actorIds?: string[];
  rank: number;
  topicId?: mongoose.Types.ObjectId;
  calculatedAt: Date;
  updatedAt: Date;
}

// `_id` is omitted from the document side: Mongoose's `Document` declares its own
// (generic, optional) `_id`, and an interface cannot extend two parents that
// disagree about a property. The lean type above is the one that must be exact,
// because it is what leaves the process as JSON.
export interface ITrending extends Omit<TrendingRecord, '_id'>, Document {}

const TrendingSchema = new Schema({
  type: {
    type: String,
    enum: Object.values(TrendingType),
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  terms: {
    type: [String],
    default: undefined,
  },
  // Required for every NEW row: a trend a reader cannot read is not a trend.
  // Pre-existing rows predate labels and simply lack it (Mongoose validates on
  // write, never on read), which is why the read type keeps it optional.
  displayName: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    enum: TREND_CATEGORIES,
  },
  labelVersion: {
    type: Number,
  },
  languages: {
    type: [String],
    default: undefined,
  },
  description: {
    type: String,
    default: '',
  },
  score: {
    type: Number,
    required: true,
    index: true,
  },
  volume: {
    type: Number,
    required: true,
    default: 0,
  },
  authorCount: {
    type: Number,
  },
  burstScore: {
    type: Number,
  },
  momentum: {
    type: Number,
    required: true,
    default: 0,
  },
  startedAt: {
    type: Date,
  },
  status: {
    type: String,
    enum: ['hot'],
  },
  actorIds: {
    type: [String],
    default: undefined,
  },
  rank: {
    type: Number,
    required: true,
  },
  topicId: {
    type: Schema.Types.ObjectId,
    ref: 'Topic',
    index: true,
  },
  calculatedAt: {
    type: Date,
    required: true,
    // No inline `index: true` here — the single-field `{ calculatedAt: 1 }`
    // index is declared below WITH `expireAfterSeconds` (TTL). Declaring both
    // would produce two indexes with the same key pattern and conflict.
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Efficient query for latest batch and history browsing
TrendingSchema.index({ calculatedAt: -1, score: -1 });

// Unique constraint: the same trend can't appear twice in the same batch — and a
// trend is a (name, type) pair, not a name. A hashtag someone typed and a topic
// the classifier inferred are different things that carry different volumes and
// route to different screens (`/hashtag/science` vs `/trend/science`), so both
// legitimately appear in one batch under the same name. Keying uniqueness on the
// name alone made that collision fatal: the batch insert aborted on it and the
// job stopped publishing, freezing `GET /trending` on its last complete batch.
//
// `type` is deliberately LAST. `{ name, calculatedAt }` stays an exact index
// prefix, so the per-name volume-series range scan behind the sparkline
// (`TrendingService.loadVolumeSeries`) still gets its sort straight from the
// index; verified by explain — moving `type` into the middle instead adds a
// blocking SORT stage.
//
// NOTE: `autoIndex`/`autoCreate` are OFF in production — the widened index is
// created (and the old `{ name, calculatedAt }` one dropped) by migration
// `0013-trending-name-type-unique-index`, not on model load.
TrendingSchema.index({ name: 1, calculatedAt: 1, type: 1 }, { unique: true });

// TTL index: MongoDB's background monitor reaps rows older than the retention
// window so the collection stays bounded. This is ALSO the ascending
// single-field `{ calculatedAt: 1 }` index, so range queries such as the
// history aggregation's `{ calculatedAt: { $gte: cutoff } }` use it directly.
// NOTE: `autoIndex`/`autoCreate` are OFF in production — this index is created
// by migration `0003-trending-ttl-index`, not on model load.
TrendingSchema.index({ calculatedAt: 1 }, { expireAfterSeconds: TRENDING_TTL_SECONDS });

export default mongoose.model<ITrending>("Trending", TrendingSchema);
