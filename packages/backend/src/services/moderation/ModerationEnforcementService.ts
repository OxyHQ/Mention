import mongoose from 'mongoose';
import type { Decision } from '@oxyhq/crowdsource-contracts';
import type {
  ModerationEnforcementAction,
  ModerationEnforcementMode,
} from '@mention/shared-types';
import ModerationEnforcement, {
  type IModerationEnforcement,
} from '../../models/ModerationEnforcement';
import Post from '../../models/Post';
import { ReportedType } from '../../models/Report.model';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { planEnforcement, type PlannedEnforcementAction } from './enforcementPlan';

/**
 * Carrying out a decision, exactly once.
 *
 * Two guarantees, and everything here exists for one of them.
 *
 * **Once.** Appendix D's key is `decisionId + revision + action`, and the unique
 * index on `ModerationEnforcement` is that key. Each action CLAIMS its row before
 * doing anything; a second attempt — a redelivered webhook, a reclaimed outbox
 * lease, a manual replay — loses the insert and does nothing. Reading "have I done
 * this?" and then acting would leave the gap between the two, which is exactly when
 * a redelivery arrives.
 *
 * **Reversibly.** Every action that changes state records what the state WAS, and a
 * reversal puts that back. So a correction does not lift a content warning the
 * author set themselves, and a restore returns a post to the status it actually had
 * rather than to a guess at one.
 *
 * `observe` mode runs all of this except the effect. That is deliberate: the plan,
 * the claim and the record are identical to production, so what the mode proves is
 * exactly what will happen when it is switched off — and the audit trail is real
 * rather than a log line saying a decision was seen.
 */

export interface EnforcementSubject {
  /** Mention's own noun (`post`, `comment`, `user`, …). */
  type: string;
  id: string;
}

export interface EnforcementOutcome {
  action: ModerationEnforcementAction;
  /**
   * `applied` — the effect happened. `recorded` — claimed and deliberately not
   * carried out (observe/manual mode, or nothing to undo). `duplicate` — another
   * delivery of this same decision revision already handled it.
   */
  result: 'applied' | 'recorded' | 'duplicate';
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

/** Post-backed subjects. A comment is a post with a parent. */
const POST_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  ReportedType.POST,
  ReportedType.COMMENT,
]);

interface PostState {
  status?: string;
  metadata?: { isSensitive?: boolean };
}

async function loadPostState(postId: string): Promise<PostState | null> {
  if (!mongoose.isValidObjectId(postId)) return null;
  return await Post.findById(postId)
    .select('status metadata.isSensitive')
    .lean<PostState | null>();
}

/**
 * The effect of one action, or why there was none.
 *
 * Returns the state that was replaced, so the record can reverse it later. A `null`
 * effect means the action was claimed and correctly did nothing — the post is
 * already gone, or there was no restriction to undo — which is a different thing
 * from a failure and is recorded as such.
 */
async function applyEffect(
  action: ModerationEnforcementAction,
  subject: EnforcementSubject,
): Promise<
  | { changed: true; previousState: IModerationEnforcement['previousState'] }
  | { changed: false; reason: string }
> {
  if (action === 'none' || action === 'manual_review') {
    return { changed: false, reason: `Action '${action}' has no effect by definition` };
  }

  if (!POST_SUBJECT_TYPES.has(subject.type)) {
    /**
     * A reported ACCOUNT is not Mention's to suspend — Oxy owns accounts, and an
     * application that reached into another product's user state would be doing
     * exactly what the one-way reputation rule forbids. Recorded for a human.
     */
    return {
      changed: false,
      reason: `Mention has no '${action}' effect for a reported ${subject.type}`,
    };
  }

  const current = await loadPostState(subject.id);
  if (!current) return { changed: false, reason: 'The reported post no longer exists' };

  switch (action) {
    case 'restrict': {
      if (current.status === 'restricted') {
        return { changed: false, reason: 'The post was already restricted' };
      }
      await Post.updateOne({ _id: subject.id }, { $set: { status: 'restricted' } });
      return { changed: true, previousState: { postStatus: current.status ?? 'published' } };
    }

    case 'restore': {
      if (current.status !== 'restricted') {
        return { changed: false, reason: 'The post was not restricted' };
      }
      /**
       * Restored to what it WAS, read off the enforcement row that restricted it —
       * not to a hardcoded `published`. A draft that was somehow restricted must not
       * be published by a correction.
       */
      const restriction = await ModerationEnforcement.findOne({
        subjectType: subject.type,
        subjectId: subject.id,
        action: 'restrict',
        applied: true,
      })
        .sort({ createdAt: -1 })
        .lean<Pick<IModerationEnforcement, 'previousState'> | null>();
      const restoreTo = restriction?.previousState?.postStatus ?? 'published';
      await Post.updateOne({ _id: subject.id }, { $set: { status: restoreTo } });
      return { changed: true, previousState: { postStatus: 'restricted' } };
    }

    case 'label_sensitive': {
      if (current.metadata?.isSensitive === true) {
        return { changed: false, reason: 'The post already carried a content warning' };
      }
      await Post.updateOne({ _id: subject.id }, { $set: { 'metadata.isSensitive': true } });
      return { changed: true, previousState: { metadataIsSensitive: false } };
    }

    case 'unlabel_sensitive': {
      /**
       * Only lifted if MODERATION set it. An author's own content warning is theirs,
       * and a correction that removed it would be a moderation action nobody asked
       * for — visible to no-one until the post appeared in discovery again.
       */
      const label = await ModerationEnforcement.findOne({
        subjectType: subject.type,
        subjectId: subject.id,
        action: 'label_sensitive',
        applied: true,
      })
        .sort({ createdAt: -1 })
        .lean<Pick<IModerationEnforcement, '_id'> | null>();
      if (!label) {
        return { changed: false, reason: 'The content warning was not set by moderation' };
      }
      if (current.metadata?.isSensitive !== true) {
        return { changed: false, reason: 'The post carried no content warning' };
      }
      await Post.updateOne({ _id: subject.id }, { $set: { 'metadata.isSensitive': false } });
      return { changed: true, previousState: { metadataIsSensitive: true } };
    }
  }
}

/**
 * Whether the current mode allows this action to actually happen.
 *
 * `observe` allows nothing — that is the mode. `manual` allows the reversible,
 * low-consequence half: restoring content and lifting a warning give something
 * BACK, and holding those behind a human review means a wrongly-removed post stays
 * removed while somebody reads a queue. Taking content down still waits for a
 * person. `automatic` allows the mapped set.
 */
function modeAllows(
  mode: ModerationEnforcementMode,
  action: ModerationEnforcementAction,
): boolean {
  switch (mode) {
    case 'observe':
      return false;
    case 'manual':
      return action === 'restore' || action === 'unlabel_sensitive';
    case 'automatic':
      return true;
  }
}

export interface ApplyDecisionEnforcementInput {
  decision: Decision;
  caseId: string;
  subject: EnforcementSubject;
  /** Defaults to the configured mode. Explicit in tests. */
  mode?: ModerationEnforcementMode;
}

/**
 * Plan and carry out everything this decision revision asks for.
 *
 * Returns one outcome per planned action, in plan order, so a caller can record what
 * happened without asking a second time.
 */
export async function applyDecisionEnforcement(
  input: ApplyDecisionEnforcementInput,
): Promise<EnforcementOutcome[]> {
  const mode = input.mode ?? config.crowdSource.enforcementMode;
  const plan = planEnforcement(input.decision);
  const outcomes: EnforcementOutcome[] = [];

  for (const planned of plan) {
    outcomes.push(await applyOne(planned, input, mode));
  }
  return outcomes;
}

async function applyOne(
  planned: PlannedEnforcementAction,
  input: ApplyDecisionEnforcementInput,
  mode: ModerationEnforcementMode,
): Promise<EnforcementOutcome> {
  const { decision, caseId, subject } = input;

  /**
   * The claim. The unique index refuses a second row for this
   * `decisionId + revision + action`, so losing this insert is the answer "another
   * delivery already handled it" and not an error.
   */
  let record: IModerationEnforcement;
  try {
    record = await ModerationEnforcement.create({
      decisionId: decision.id,
      decisionRevision: decision.revision,
      action: planned.action,
      caseId,
      subjectType: subject.type,
      subjectId: subject.id,
      outcome: decision.outcome,
      ...(planned.recommendedAction === undefined
        ? {}
        : { recommendedAction: planned.recommendedAction }),
      reason: planned.reason,
      mode,
      applied: false,
    });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      metrics.incrementCounter('crowdsource_enforcement_total', 1, {
        action: planned.action,
        mode,
        result: 'duplicate',
      });
      return { action: planned.action, result: 'duplicate' };
    }
    throw error;
  }

  if (!modeAllows(mode, planned.action)) {
    await ModerationEnforcement.updateOne(
      { _id: record._id },
      {
        $set: {
          skippedReason:
            mode === 'observe'
              ? 'observe mode: recorded, not applied'
              : `${mode} mode does not apply '${planned.action}' automatically`,
        },
      },
    );
    metrics.incrementCounter('crowdsource_enforcement_total', 1, {
      action: planned.action,
      mode,
      result: 'recorded',
    });
    return { action: planned.action, result: 'recorded' };
  }

  try {
    const effect = await applyEffect(planned.action, subject);
    if (!effect.changed) {
      await ModerationEnforcement.updateOne(
        { _id: record._id },
        { $set: { skippedReason: effect.reason } },
      );
      metrics.incrementCounter('crowdsource_enforcement_total', 1, {
        action: planned.action,
        mode,
        result: 'recorded',
      });
      return { action: planned.action, result: 'recorded' };
    }

    await ModerationEnforcement.updateOne(
      { _id: record._id },
      {
        $set: {
          applied: true,
          appliedAt: new Date(),
          ...(effect.previousState === undefined
            ? {}
            : { previousState: effect.previousState }),
        },
      },
    );
    metrics.incrementCounter('crowdsource_enforcement_total', 1, {
      action: planned.action,
      mode,
      result: 'applied',
    });
    return { action: planned.action, result: 'applied' };
  } catch (error: unknown) {
    /**
     * The claim goes back so a retry can try again. Keeping it would make a
     * transient failure permanent: the action would be deduplicated away forever and
     * the decision would silently never be carried out.
     */
    await ModerationEnforcement.deleteOne({ _id: record._id });
    logger.error('[CrowdSource] enforcement effect failed, claim released', {
      decisionId: decision.id,
      revision: decision.revision,
      action: planned.action,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
