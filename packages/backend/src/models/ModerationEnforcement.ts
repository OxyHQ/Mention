import mongoose, { Document, Schema } from 'mongoose';
import type {
  ModerationEnforcementAction,
  ModerationEnforcementMode,
} from '@mention/shared-types';

/**
 * The actions this schema accepts, owned HERE rather than imported.
 *
 * It used to come from `Report.model`, which the port deleted once its last
 * importer moved to Postgres — and a deleted file cannot be imported by a
 * deleted file, which is what `closedValueSets.test.ts` reported: its recovery
 * materialises a removed model out of git history and IMPORTS it, so this file
 * became unloadable in both the tree and the past, taking
 * `moderation_enforcements.action` and `.mode` out of the comparison entirely.
 *
 * This model has no runtime importer left; the reason it is still here is that
 * it is the MONGOOSE REFERENT the closed-value-set gate compares the Postgres
 * vocabulary against, and the backfill still reads that collection out of the
 * live database. It goes when the collection does, not before.
 */
const REPORT_ENFORCEMENT_ACTIONS: readonly ModerationEnforcementAction[] = [
  'none',
  'restrict',
  'restore',
  'label_sensitive',
  'unlabel_sensitive',
  'manual_review',
];

/**
 * What Mention did about a decision — one row per action, and the reason it is
 * impossible to do twice.
 *
 * Appendix D fixes the idempotency key: `decisionId + revision + action`. The
 * unique index below IS that key, and it is the whole mechanism: a redelivered
 * webhook, a reclaimed outbox lease and a manual replay all try to insert the same
 * row, and only the first one can. Checking "have I done this?" with a read before
 * a write would leave the window between them, which is precisely the window a
 * redelivery arrives in.
 *
 * `revision` is in the key for a reason of its own. A correction is a NEW revision
 * that supersedes the old one (§9.9), so the restore it asks for is a different
 * action from the removal that came before and must be allowed to happen — while
 * still being impossible to apply twice itself.
 *
 * `previousState` is what makes reversibility real rather than aspirational. A
 * restore returns the post to what it WAS, so an author's own content warning is not
 * silently lifted by a moderation correction that never set it.
 */
export interface IModerationEnforcement extends Document {
  decisionId: string;
  decisionRevision: number;
  action: ModerationEnforcementAction;

  caseId: string;
  /** Mention's own noun, e.g. `post`. Never a CrowdSource resource id. */
  subjectType: string;
  subjectId: string;

  /** The decision outcome this action answered. */
  outcome: string;
  /** The recommendation it came from, when it came from one (§7.6). */
  recommendedAction?: string;
  /** Why this action, in words an operator can read. Never reported material. */
  reason: string;

  mode: ModerationEnforcementMode;
  /**
   * Whether the effect was actually carried out.
   *
   * `false` in `observe` mode for every action, which is the point of the mode: the
   * plan is recorded and auditable, and nothing is removed.
   */
  applied: boolean;
  appliedAt?: Date;
  /** Why an action was recorded but not carried out. */
  skippedReason?: string;

  /** What to put back on a reversal. Only set for an action that changed state. */
  previousState?: {
    postStatus?: string;
    metadataIsSensitive?: boolean;
  };

  createdAt: Date;
  updatedAt: Date;
}

export const MODERATION_ENFORCEMENT_COLLECTION = 'moderation_enforcements';

const ModerationEnforcementSchema = new Schema<IModerationEnforcement>(
  {
    decisionId: { type: String, required: true },
    decisionRevision: { type: Number, required: true, min: 1 },
    action: { type: String, required: true, enum: REPORT_ENFORCEMENT_ACTIONS },

    caseId: { type: String, required: true, index: true },
    subjectType: { type: String, required: true },
    subjectId: { type: String, required: true },

    outcome: { type: String, required: true },
    recommendedAction: { type: String },
    reason: { type: String, required: true, maxlength: 500 },

    mode: { type: String, required: true, enum: ['observe', 'manual', 'automatic'] },
    applied: { type: Boolean, required: true, default: false },
    appliedAt: { type: Date },
    skippedReason: { type: String, maxlength: 300 },

    previousState: {
      postStatus: { type: String },
      metadataIsSensitive: { type: Boolean },
    },
  },
  { timestamps: true, collection: MODERATION_ENFORCEMENT_COLLECTION },
);

/**
 * Appendix D's key. Unique, and load-bearing: without it a redelivered decision
 * removes a post twice, and a redelivered correction restores it twice.
 */
ModerationEnforcementSchema.index(
  { decisionId: 1, decisionRevision: 1, action: 1 },
  { unique: true },
);
// Operational: what has been done to this object, newest first.
ModerationEnforcementSchema.index({ subjectType: 1, subjectId: 1, createdAt: -1 });

export const ModerationEnforcement = mongoose.model<IModerationEnforcement>(
  'ModerationEnforcement',
  ModerationEnforcementSchema,
);

export default ModerationEnforcement;
