/**
 * The one place a report's two status axes are decided.
 *
 * §14.3 requires the legacy `status` field to keep working through a
 * compatibility stage rather than being renamed destructively. Two status fields
 * maintained by two call sites is how they drift, so both are derived here — from
 * the decision, not from each other — and every writer in the moderation
 * pipeline goes through {@link reportStateForDecision} or the small helpers
 * below.
 *
 * The mapping is deliberately conservative about the difference between "a jury
 * looked at this" and "this was a violation". `resolved` and `dismissed` are the
 * two legacy values that carry a verdict, so only an outcome that IS a verdict
 * may produce them:
 *
 * - `violation` → `resolved`: the case reached a conclusion Mention can act on.
 * - `no_violation` → `dismissed`: the allegation was not upheld.
 * - `insufficient_context`, `inconclusive`, `content_unavailable`, `duplicate`,
 *   `escalated` → `reviewed`: a jury engaged and produced no verdict. Mapping any
 *   of these to `dismissed` would turn "we could not tell" into "nothing was
 *   wrong", which is the exact collapse the invariants forbid — absence of
 *   consensus is neither guilt nor innocence.
 *
 * An outcome this version does not know also maps to `reviewed`: a newer
 * CrowdSource must not be able to silently produce `dismissed` here.
 */

import { ReportStatus } from '../../models/Report.model';
import type { ModerationLocalStatus } from '@mention/shared-types';

/**
 * The outcome, as a string.
 *
 * Not imported as `DecisionOutcome` on purpose: this function is reached from the
 * decision worker with a value that came off the wire, and §10.11 requires an
 * unrecognised outcome to be handled rather than to throw. The known values are
 * matched explicitly and everything else falls through.
 */
export function legacyStatusForOutcome(outcome: string): ReportStatus {
  switch (outcome) {
    case 'violation':
      return ReportStatus.RESOLVED;
    case 'no_violation':
      return ReportStatus.DISMISSED;
    default:
      return ReportStatus.REVIEWED;
  }
}

export interface ReportDecisionState {
  status: ReportStatus;
  localStatus: ModerationLocalStatus;
}

/**
 * Decision statuses that end Mention's side of the case.
 *
 * A `provisional` decision leaves the report at `submitted`: §9.6 allows a later
 * revision to supersede it, and a report Mention had already closed would have to
 * be reopened. `superseded` is not here either — a superseded revision is not the
 * current answer and must never be the one that closes the report.
 */
const TERMINAL_DECISION_STATUSES: ReadonlySet<string> = new Set(['final', 'corrected']);

/** Both axes for a report whose case has been decided. */
export function reportStateForDecision(input: {
  outcome: string;
  decisionStatus: string;
}): ReportDecisionState {
  return {
    status: legacyStatusForOutcome(input.outcome),
    localStatus: TERMINAL_DECISION_STATUSES.has(input.decisionStatus) ? 'closed' : 'submitted',
  };
}
