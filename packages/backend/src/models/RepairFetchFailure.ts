import mongoose, { Document, Schema } from 'mongoose';

/**
 * One post whose source re-fetch failed during an administrative sweep, kept so
 * the failures can be RETRIED WITHOUT RE-WALKING THE CORPUS.
 *
 * WHY THIS EXISTS
 *   The repair sweep's candidate filter selects "federated, no mentions, an
 *   `@`-shaped body". It cannot distinguish a post that failed because its origin
 *   was briefly unreachable from one whose mentioned actor is simply not in our
 *   index, or whose origin answered 410 and never will. Measured on 2026-08-01,
 *   the completed sweep left 46,291 candidates of which only 5,691 were transient
 *   failures — so retrying that tail through the filter would cost ~40,600
 *   requests to other people's servers that cannot produce a repair, and the
 *   right answer was therefore to not retry at all.
 *
 *   Recording WHY each post failed turns that trade-off around: a later run can
 *   read the 5,691 directly. Being a good fediverse citizen is the constraint, so
 *   the cheaper a targeted retry is, the more likely the tail ever gets fixed.
 *
 * SHAPE
 *   Keyed `(script, postId)` and upserted, so the collection is bounded by the
 *   number of DISTINCT failing posts however many times a sweep runs, and a post
 *   that fails again simply refreshes its reason and timestamp.
 *
 *   A row is evidence that a fetch failed AT `failedAt`, not that the post is
 *   still broken — a later run (or the live outbox self-heal) may have repaired
 *   it since. A consumer therefore intersects these ids with the sweep's live
 *   candidate filter rather than trusting them alone; that is also what keeps a
 *   stale row from costing anything beyond being skipped.
 */
export interface IRepairFetchFailure extends Document {
  /** The sweep that saw the failure — the same token its cursor is keyed on. */
  script: string;
  /** The `Post._id` whose source could not be re-fetched, as a hex string. */
  postId: string;
  /**
   * How the re-fetch failed. `timeout` / `transport` / `httpStatus` are the
   * remote world being imperfect and are the retryable set; `nonObjectPayload` /
   * `malformedJson` mean we reached the origin and could not parse the answer,
   * which is a mapping failure on our side and fails the run outright.
   */
  reason: string;
  /**
   * The HTTP status, when the transport got far enough to see one. Kept because
   * it is what separates "retry politely" (429, 5xx) from "do not come back"
   * (403, 401) inside the single `httpStatus` reason.
   */
  status?: number;
  /** When the failure was observed. */
  failedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RepairFetchFailureSchema = new Schema<IRepairFetchFailure>({
  script: { type: String, required: true },
  postId: { type: String, required: true },
  reason: { type: String, required: true },
  status: { type: Number },
  failedAt: { type: Date, required: true },
}, {
  timestamps: true,
});

RepairFetchFailureSchema.index({ script: 1, postId: 1 }, { unique: true });
// The targeting query: "every post this sweep failed to fetch for a retryable
// reason". Without it, the one read this collection exists to serve is a scan.
RepairFetchFailureSchema.index({ script: 1, reason: 1 });

export const RepairFetchFailure = mongoose.model<IRepairFetchFailure>(
  'RepairFetchFailure',
  RepairFetchFailureSchema,
);
