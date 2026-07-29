/**
 * Mention's local moderation-integration contract.
 *
 * CrowdSource is the source of truth for cases, reviews and decisions; Oxy Trust
 * is the source of truth for reputation; Mention stays the source of truth for
 * its own enforcement actions. These types describe only Mention's half — the
 * receipt a reporter can read and the local state of the integration — and they
 * are deliberately NOT a copy of anything `@oxyhq/crowdsource-contracts`
 * publishes. A `Decision`, a `TaxonomyCode` or a `RecommendedAction` has exactly
 * one definition and it lives in that package; what a decision produced *here*
 * lives below.
 *
 * The one field that crosses over is {@link ModerationReportReceipt.decisionOutcome},
 * kept as an open string on purpose: CrowdSource may add an outcome (§10.11
 * requires a newer server not to break an older client) and a report receipt is
 * the wrong place for that to become a type error in a client bundle.
 */

/**
 * Where a report is in Mention's own delivery pipeline (§14.3).
 *
 * This is the INTEGRATION axis and says nothing about guilt. A report sitting at
 * `submitted` has been accepted by CrowdSource and is waiting for a jury; it has
 * not been judged, and nothing in this union ever means "the content was bad".
 *
 * There is deliberately no state meaning "stored, and nothing will ever happen to
 * it". A report Mention cannot act on is REFUSED at the API rather than accepted
 * into a terminal state: accepting it would tell a reporter their report was
 * received when nothing would ever read it again, and nothing would alert on a
 * queue that was designed never to drain.
 */
export type ModerationLocalStatus =
  | 'received'
  | 'queued'
  | 'submitted'
  | 'delivery_failed'
  | 'closed';

/**
 * The legacy moderation-lifecycle axis, unchanged.
 *
 * Kept because `GET /reports` filters on it and clients have shipped against it.
 * It is derived from the decision by one central function in the backend
 * (`reportStatus.ts`) rather than written from more than one place — two
 * independently-maintained status fields is how they drift.
 */
export type ModerationReportStatus = 'pending' | 'reviewed' | 'resolved' | 'dismissed';

/**
 * What Mention did about a decision.
 *
 * §7.6 gives the application control of its own product and requires it to
 * record what it did and why — including refusing a recommendation. So this is a
 * record of Mention's action, never a restatement of the finding:
 *
 * - `none` — the decision asked for nothing that applies here.
 * - `restrict` — the post is no longer published. Reversible by `restore`.
 * - `restore` — an earlier restriction was undone, normally by a correction.
 * - `label_sensitive` / `unlabel_sensitive` — the content warning was applied or lifted.
 * - `manual_review` — the recommendation is one Mention will not execute
 *   automatically (a suspension belongs to Oxy, not to Mention) and it is queued
 *   for a human instead. Recording it is the point: a recommendation Mention
 *   declined must not look like one it never received.
 */
export type ModerationEnforcementAction =
  | 'none'
  | 'restrict'
  | 'restore'
  | 'label_sensitive'
  | 'unlabel_sensitive'
  | 'manual_review';

/**
 * How much of a decision Mention is allowed to act on (§14.6).
 *
 * `observe` is the first deployment and removes nothing: decisions are received,
 * stored and PLANNED, and every planned action is recorded as not applied. That
 * record is what makes the mode auditable rather than a silent no-op — you can
 * read exactly what would have happened.
 */
export type ModerationEnforcementMode = 'observe' | 'manual' | 'automatic';

/** The report state a reporter is allowed to see. */
export interface ModerationReportReceipt {
  id: string;
  reportedType: string;
  reportedId: string;
  categories: string[];
  details?: string;
  /** @see ModerationReportStatus */
  status: ModerationReportStatus;
  /** @see ModerationLocalStatus */
  localStatus: ModerationLocalStatus;
  /**
   * CrowdSource's outcome, open-ended by design — see the module comment.
   * Absent until a decision arrives.
   */
  decisionOutcome?: string;
  /** What Mention did. Absent until a decision has been applied. */
  enforcedAction?: ModerationEnforcementAction;
  enforcedAt?: string;
  createdAt: string;
  updatedAt: string;
}
