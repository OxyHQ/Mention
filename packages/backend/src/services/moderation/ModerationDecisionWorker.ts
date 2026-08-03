import { DecisionSchema, type Decision } from '@oxyhq/crowdsource-contracts';
import type { ModerationEnforcementAction } from '@mention/shared-types';
import {
  applyDecisionToReport,
  findReportsForCase,
} from '../../db/moderation/reportRepository';
import { logger } from '../../utils/logger';
import { applyDecisionEnforcement } from './ModerationEnforcementService';
import type { ModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository';
import { reportStateForDecision } from './reportStatus';

/**
 * Applying a decision that has already been received and recorded.
 *
 * The webhook answered 2xx long before this runs (§10.8). What is left is the part
 * that touches several collections: write the decision onto every report that opened
 * or joined the case, and enforce it once.
 *
 * "Once" is the invariant that shapes this file. A hundred reports about the same
 * material produce ONE case and ONE consequence, so enforcement is keyed on the
 * decision and not on the reports — `ModerationEnforcementService` is called a single
 * time no matter how many reports are updated, and its own unique index makes even
 * that call safe to repeat.
 */

/** A failure that will not be fixed by trying again. */
export class ModerationDecisionRejectedError extends Error {
  /** Read by the outbox: `false` dead-letters instead of retrying (§10.5). */
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ModerationDecisionRejectedError';
  }
}

/** A failure that a later attempt can still resolve. */
export class ModerationDecisionDeferredError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'ModerationDecisionDeferredError';
  }
}

/**
 * Write the decision onto one report.
 *
 * The filter carries the revision guard, so it is the DATABASE that refuses a stale
 * write rather than a read-then-write in this process. Deliveries can overlap —
 * §10.9 retries for 24 hours, and a correction can arrive while the decision it
 * supersedes is still being applied — and an older revision landing last would
 * otherwise overwrite the current answer with a stale one.
 */
async function applyToReport(
  reportId: string,
  decision: Decision,
  enforcedAction: ModerationEnforcementAction | undefined,
): Promise<boolean> {
  const state = reportStateForDecision({
    outcome: decision.outcome,
    decisionStatus: decision.status,
  });

  return applyDecisionToReport(reportId, {
    status: state.status,
    localStatus: state.localStatus,
    decisionId: decision.id,
    decisionRevision: decision.revision,
    decisionOutcome: decision.outcome,
    decisionStatus: decision.status,
    decidedAt: new Date(decision.publishedAt),
    ...(enforcedAction === undefined ? {} : { enforcedAction }),
  });
}

/**
 * The action worth recording on the report.
 *
 * One field, several planned actions, so it has to be the one that answers "what
 * happened to this content". A state-changing action beats a note for a human, which
 * beats an explicit nothing — and `manual_review` still reaches the report, because a
 * reporter told "nothing happened" when a human is about to look is being told
 * something untrue.
 */
const ACTION_PRECEDENCE: readonly ModerationEnforcementAction[] = [
  'restrict',
  'restore',
  'label_sensitive',
  'unlabel_sensitive',
  'manual_review',
  'none',
];

function primaryAction(
  actions: readonly ModerationEnforcementAction[],
): ModerationEnforcementAction | undefined {
  for (const candidate of ACTION_PRECEDENCE) {
    if (actions.includes(candidate)) return candidate;
  }
  return undefined;
}

/** Handle one `decision.apply` outbox event. */
export async function applyDecisionOutboxEvent(
  event: ModerationOutboxEvent,
): Promise<void> {
  const caseId = event.payload.caseId;
  if (caseId === undefined) {
    throw new ModerationDecisionRejectedError(
      'A decision.apply event carried no caseId.',
    );
  }

  /**
   * Parsed HERE rather than at the webhook.
   *
   * The receiver's job was to prove the bytes came from CrowdSource and to record
   * them; refusing an unrecognised shape at the door would put a real decision back
   * on a retry schedule until it expired. Parsing at the point of use means an event
   * this deployment cannot yet read waits in the outbox until it can.
   */
  const parsed = DecisionSchema.safeParse(event.payload.decision);
  if (!parsed.success) {
    throw new ModerationDecisionRejectedError(
      `The decision for case ${caseId} does not match the published contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const decision = parsed.data;

  const reports = await findReportsForCase(caseId);

  if (reports.length === 0) {
    /**
     * Retryable, and the race is real rather than theoretical: CrowdSource can decide
     * a case and deliver the webhook while the 202 that carried the case id back to
     * this deployment is still being written, or while a delivery is being retried.
     * Backing off is correct; dead-lettering would throw the decision away.
     */
    throw new ModerationDecisionDeferredError(
      `No local report is linked to case ${caseId} yet.`,
    );
  }

  /**
   * One subject per case. §7.3's dedup key includes `subject.externalId`, so every
   * report merged into a case is about the same object — the first report names it.
   */
  const [first] = reports;
  const outcomes = await applyDecisionEnforcement({
    decision,
    caseId,
    subject: { type: first.reportedType, id: first.reportedId },
  });

  const enforcedAction = primaryAction(outcomes.map((outcome) => outcome.action));

  let updated = 0;
  for (const report of reports) {
    if (await applyToReport(report.id, decision, enforcedAction)) updated += 1;
  }

  logger.info('[CrowdSource] decision applied', {
    caseId,
    decisionId: decision.id,
    revision: decision.revision,
    outcome: decision.outcome,
    reportsMatched: reports.length,
    reportsUpdated: updated,
    actions: outcomes.map((outcome) => `${outcome.action}:${outcome.result}`).join(','),
  });
}
