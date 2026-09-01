import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Decision } from '@oxyhq/crowdsource-contracts';
import type {
  ModerationEnforcementAction,
  ModerationEnforcementMode,
} from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { moderationEnforcements } from '../../db/schema/moderation';
import { POST_STATUSES, posts } from '../../db/schema/posts';
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

/** Post-backed subjects. A comment is a post with a parent. */
const POST_SUBJECT_TYPES: ReadonlySet<string> = new Set(['post', 'comment']);

/**
 * What a reversal has to put back, as the two columns that hold it.
 *
 * Mongo stored this as a `previousState` subdocument; flattened, an action that
 * changed nothing simply writes neither column. Both stay optional for that
 * reason — `undefined` means "this action did not touch that field", which is
 * not the same as `null`.
 */
interface EnforcementPreviousState {
  previousStatePostStatus?: string;
  previousStateMetadataIsSensitive?: boolean;
}

/** Derived from the column, so it cannot drift from what the CHECK accepts. */
type PostStatus = (typeof posts.$inferSelect)['status'];

interface PostState {
  status: PostStatus;
  metadataIsSensitive: boolean;
}

/**
 * The post's enforceable state, or `null` when there is no such post.
 *
 * There is deliberately NO id-shape guard here. The Mongoose version tested
 * `isValidObjectId` first, purely to dodge a `CastError` — but the caller reads
 * `null` as "the reported post no longer exists", so any subject id that was not
 * 24-char hex turned EVERY enforcement action into a silent no-op that recorded
 * a plausible reason in the audit trail. Post ids are `text` now: a
 * uuid v7 matches its row, a pre-cutover ObjectId hex matches its row, and an id
 * that is neither matches nothing — which is the honest answer the caller was
 * already written for.
 */
async function loadPostState(postId: string): Promise<PostState | null> {
  const [row] = await getDb()
    .select({ status: posts.status, metadataIsSensitive: posts.metadataIsSensitive })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return row ?? null;
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
  | { changed: true; previousState: EnforcementPreviousState }
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
      await getDb()
        .update(posts)
        .set({ status: 'restricted' })
        .where(eq(posts.id, subject.id));
      return { changed: true, previousState: { previousStatePostStatus: current.status } };
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
      const [restriction] = await getDb()
        .select({ postStatus: moderationEnforcements.previousStatePostStatus })
        .from(moderationEnforcements)
        .where(appliedActionFilter(subject, 'restrict'))
        .orderBy(...RESTRICTION_IN_FORCE_ORDER)
        .limit(1);
      const restoreTo = asPostStatus(restriction?.postStatus);
      await getDb().update(posts).set({ status: restoreTo }).where(eq(posts.id, subject.id));
      return { changed: true, previousState: { previousStatePostStatus: 'restricted' } };
    }

    case 'label_sensitive': {
      if (current.metadataIsSensitive) {
        return { changed: false, reason: 'The post already carried a content warning' };
      }
      await getDb()
        .update(posts)
        .set({ metadataIsSensitive: true })
        .where(eq(posts.id, subject.id));
      return { changed: true, previousState: { previousStateMetadataIsSensitive: false } };
    }

    case 'unlabel_sensitive': {
      /**
       * Only lifted if MODERATION set it. An author's own content warning is theirs,
       * and a correction that removed it would be a moderation action nobody asked
       * for — visible to no-one until the post appeared in discovery again.
       *
       * An EXISTENCE question, so it deliberately carries no ORDER BY: unlike the
       * restore above there is no state to read back off the winning row, every
       * matching row answers it identically, and a sort that decides nothing
       * reads in this file as though it decides something.
       */
      const [label] = await getDb()
        .select({ id: moderationEnforcements.id })
        .from(moderationEnforcements)
        .where(appliedActionFilter(subject, 'label_sensitive'))
        .limit(1);
      if (!label) {
        return { changed: false, reason: 'The content warning was not set by moderation' };
      }
      if (!current.metadataIsSensitive) {
        return { changed: false, reason: 'The post carried no content warning' };
      }
      await getDb()
        .update(posts)
        .set({ metadataIsSensitive: false })
        .where(eq(posts.id, subject.id));
      return { changed: true, previousState: { previousStateMetadataIsSensitive: true } };
    }
  }
}

/**
 * Rows that actually CARRIED OUT `action` against this subject.
 *
 * `applied: true` is the load-bearing half: an `observe`-mode row records a plan
 * that never happened, so treating one as the thing to reverse would restore a
 * post nothing removed. Written once because both reversal branches need exactly
 * this predicate and a copy could lose that clause in only one of them.
 */
function appliedActionFilter(
  subject: EnforcementSubject,
  action: ModerationEnforcementAction,
): SQL | undefined {
  return and(
    eq(moderationEnforcements.subjectType, subject.type),
    eq(moderationEnforcements.subjectId, subject.id),
    eq(moderationEnforcements.action, action),
    eq(moderationEnforcements.applied, true),
  );
}

/**
 * Which of a subject's applied restrictions is the one still IN FORCE — i.e. the
 * one a restore is reversing, and therefore the one whose recorded
 * `previousStatePostStatus` is the status to put back.
 *
 * **`applied_at`, because it is the only column that records when the effect
 * happened.** `created_at` records when the ROW was written, and it defaults to
 * `now()` — `transaction_timestamp()` — so every row written inside ONE
 * transaction shares it to the microsecond. `order by created_at desc limit 1`
 * over a batch imported that way is a TIE, resolved by whatever the scan reached
 * first: the restore then reads a `previousStatePostStatus` recorded by some
 * OTHER restriction and puts the post back into a status it has not had for
 * months — or, where that column was never written, into the `published`
 * default, publishing something the author had left as a draft. `applied_at` is
 * a value this service writes at the moment it changes the post, so a batched
 * import preserves it and it cannot collapse the way a database default does.
 *
 * Falling back to `id` would be worse than the tie it is meant to settle: `id`
 * is `text` holding a 24-char ObjectId hex for every pre-cutover row and a uuid
 * v7 after, and `'0' < '6'` under the database's collation — so `order by id
 * desc` sorts every post-cutover enforcement LAST and hands the restore the
 * OLDEST restriction on record, every single time.
 *
 * The last two keys make the order TOTAL rather than merely better: `action` is
 * pinned by the filter, so `(decision_id, decision_revision)` is unique among
 * the candidates by Appendix D's own constraint, and a higher revision is by
 * definition the one that supersedes. Nothing here can alternate between two
 * requests.
 *
 * `nulls last` on `applied_at` because DESC defaults to NULLS FIRST: a row that
 * claims `applied` while recording no `applied_at` must not outrank one that
 * says exactly when it happened.
 */
const RESTRICTION_IN_FORCE_ORDER: SQL[] = [
  sql`${moderationEnforcements.appliedAt} desc nulls last`,
  desc(moderationEnforcements.createdAt),
  desc(moderationEnforcements.decisionRevision),
  desc(moderationEnforcements.decisionId),
];

/**
 * The recorded pre-restriction status, or `published` when there is none.
 *
 * The column is a bare `text` (it holds whatever `posts.status` held), while
 * `posts.status` is a narrow union, so the value has to be re-checked rather
 * than asserted: a row written before a status was renamed would otherwise fail
 * the CHECK constraint at restore time, turning a correction into a 500.
 */
function asPostStatus(value: string | null | undefined): PostStatus {
  return value !== null && value !== undefined && (POST_STATUSES as readonly string[]).includes(value)
    ? (value as PostStatus)
    : 'published';
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
  let recordId: string;
  try {
    const [inserted] = await getDb()
      .insert(moderationEnforcements)
      .values({
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
      })
      .returning({ id: moderationEnforcements.id });
    recordId = inserted.id;
  } catch (error: unknown) {
    // NAMED, not a bare `23505`: this branch answers for Appendix D's key and
    // nothing else. A future unique index on this table must not be silently
    // reported as "another delivery already handled it".
    if (isUniqueViolation(error, 'moderation_enforcements_idempotency_key')) {
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
    await getDb()
      .update(moderationEnforcements)
      .set({
        skippedReason:
          mode === 'observe'
            ? 'observe mode: recorded, not applied'
            : `${mode} mode does not apply '${planned.action}' automatically`,
      })
      .where(eq(moderationEnforcements.id, recordId));
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
      await getDb()
        .update(moderationEnforcements)
        .set({ skippedReason: effect.reason })
        .where(eq(moderationEnforcements.id, recordId));
      metrics.incrementCounter('crowdsource_enforcement_total', 1, {
        action: planned.action,
        mode,
        result: 'recorded',
      });
      return { action: planned.action, result: 'recorded' };
    }

    await getDb()
      .update(moderationEnforcements)
      .set({
        applied: true,
        appliedAt: new Date(),
        ...effect.previousState,
      })
      .where(eq(moderationEnforcements.id, recordId));
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
    await getDb()
      .delete(moderationEnforcements)
      .where(eq(moderationEnforcements.id, recordId));
    logger.error('[CrowdSource] enforcement effect failed, claim released', {
      decisionId: decision.id,
      revision: decision.revision,
      action: planned.action,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
