import mongoose, { Document, Schema } from 'mongoose';

/**
 * Where a long-running administrative sweep got to, so a run that dies can be
 * resumed instead of restarted.
 *
 * WHY THE DATABASE AND NOT A FILE OR A LOG LINE
 *   These sweeps are only ever run as one-shot Fargate tasks, so the container
 *   filesystem dies with the task — a cursor written to a path is gone exactly
 *   when it is needed. CloudWatch cannot hold it either: `sanitizeLogString`
 *   rewrites every 24-hex ObjectId to `[REDACTED]` and `isSensitiveKey` redacts
 *   any key ending in `id`, both covered by `__tests__/utils/loggerSanitization.test.ts`,
 *   so a logged cursor reads `[REDACTED]` whatever it is called. The database is
 *   the one durable place a sweep already holds a connection to, and keeping the
 *   id there keeps it out of the log where it does not belong.
 *
 * SCOPE
 *   A sweep may be split into parallel shards, each owning a half-open `_id`
 *   range. `scope` is the shard's declared territory, so shards record their
 *   progress independently and re-running one shard's command resumes THAT
 *   shard. The `(script, scope)` pair is unique.
 */
export interface IAdminScriptCursor extends Document {
  /** The script's own name — the same token its mutation guard confirms. */
  script: string;
  /** The shard's declared territory, canonical and deterministic per shard. */
  scope: string;
  /** The `_id` of the last document the scope scanned, as a hex string. */
  cursor: string;
  /** Documents this scope has scanned in total, accumulated across resumes. */
  scanned: number;
  /**
   * Set when the scope's range was walked to exhaustion, so a finished sweep is
   * distinguishable from one that stopped on a limit or died mid-page.
   */
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AdminScriptCursorSchema = new Schema<IAdminScriptCursor>({
  script: { type: String, required: true },
  scope: { type: String, required: true },
  cursor: { type: String, required: true },
  scanned: { type: Number, required: true, default: 0 },
  completedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

AdminScriptCursorSchema.index({ script: 1, scope: 1 }, { unique: true });

export const AdminScriptCursor = mongoose.model<IAdminScriptCursor>(
  'AdminScriptCursor',
  AdminScriptCursorSchema,
);
