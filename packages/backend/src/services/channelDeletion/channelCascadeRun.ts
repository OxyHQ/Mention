/**
 * THE RUN — what happened to every manifest step, and the schedule that decides
 * which of them this service performs at all.
 *
 * The accounting is the point. Four disjoint accounts, because "this ran and
 * affected N rows", "the delegate owns this", "a constraint did it" and "this is
 * deliberately kept" are four different statements, and collapsing them loses
 * the only one that matters.
 */

import { CHANNEL_CASCADE, type CascadeStep } from './channelCascadeManifest';
import { logger } from '../../utils/logger';
import { LOG_PREFIX } from './channelCascadeLog';
import {
  bindingKey,
  isDelegated,
  isInBatch,
  stepKey,
  type CascadePhase,
  type InBatchBinding,
  type LocalStepBinding,
} from './channelCascadeBinding';
import { countOrDelete, countRows } from './channelCascadeQueries';
import { STEP_BINDINGS } from './channelStepBindings';
import type { DeletionTargets } from './channelDeletionTargets';

/**
 * Accumulates what happened to every manifest step, and the failures that make
 * the call throw at the end.
 *
 * FOUR disjoint accounts, because "this ran and affected N rows", "the delegate
 * owns this", "a constraint did it" and "this is deliberately kept" are four
 * different statements and collapsing them loses the only one that matters.
 * Counting a non-executing step as `0` would be the worst option:
 * indistinguishable from a step that silently stopped running, which is the exact
 * failure the manifest binding exists to catch.
 */
export class CascadeRun {
  readonly steps: Record<string, number> = {};
  readonly failures: string[] = [];
  private readonly delegatedKeys = new Set<string>();
  private readonly databaseKeys = new Set<string>();
  private readonly retainedKeys = new Set<string>();

  record(key: string, countOfRows: number): void {
    this.steps[key] = (this.steps[key] ?? 0) + countOfRows;
  }

  delegate(key: string): void {
    this.delegatedKeys.add(key);
  }

  database(key: string): void {
    this.databaseKeys.add(key);
  }

  retain(key: string): void {
    this.retainedKeys.add(key);
  }

  fail(key: string, error: unknown): void {
    this.failures.push(key);
    logger.error(`${LOG_PREFIX} cascade step failed`, { step: key, error });
  }

  /**
   * A failure the delegate has ALREADY logged with its own leg name; recorded so
   * the run still throws and a retry re-runs it. Not logged a second time — two
   * entries for one failure read as two failures.
   */
  failDelegated(reference: string): void {
    this.failures.push(`PostDeletionCascade:${reference}`);
  }

  /**
   * The three non-executing key lists, made DISJOINT from `steps` and from each
   * other.
   *
   * Several columns are classified twice by scope — `notifications.entityId`,
   * `content_labels.targetId` and `reports.reportedId` each hold a post id under
   * one type discriminator and an account id under another — so one step key can
   * carry both a delegated entry and a locally executed one. Local wins, because a
   * real count is more informative than a label and because the count would
   * otherwise be silently dropped from the result. The manifest entry for the
   * non-executing half says so in its `why`, which is where a reader looks for the
   * disposition anyway.
   */
  classify(): { delegated: string[]; performedByDatabase: string[]; retained: string[] } {
    const local = new Set(Object.keys(this.steps));
    const delegated = [...this.delegatedKeys].filter((key) => !local.has(key));
    const database = [...this.databaseKeys].filter(
      (key) => !local.has(key) && !this.delegatedKeys.has(key),
    );
    return {
      delegated: delegated.sort(),
      performedByDatabase: database.sort(),
      retained: [...this.retainedKeys]
        .filter(
          (key) => !local.has(key) && !this.delegatedKeys.has(key) && !this.databaseKeys.has(key),
        )
        .sort(),
    };
  }
}

export interface ScheduledStep {
  readonly step: CascadeStep;
  readonly binding: LocalStepBinding;
}
export type CascadeSchedule = ReadonlyMap<CascadePhase, readonly ScheduledStep[]>;

export interface Schedule {
  readonly phases: CascadeSchedule;
  /** Steps the post-batch loop runs, in manifest order. */
  readonly inBatch: ReadonlyArray<{ step: CascadeStep; binding: InBatchBinding }>;
}

/**
 * Account for every manifest step exactly once, and group the ones this service
 * executes under the phase or the loop that runs them.
 *
 * Done in ONE pass over the manifest rather than per phase, so a step with no
 * binding is reported once rather than once per phase — and so the delegated,
 * database and retained accounts are complete even in a dry run, where the
 * delegate is never called.
 */
export function buildSchedule(run: CascadeRun): Schedule {
  const phases = new Map<CascadePhase, ScheduledStep[]>();
  const inBatch: Array<{ step: CascadeStep; binding: InBatchBinding }> = [];

  for (const step of CHANNEL_CASCADE) {
    // The manifest's own action decides these two, ahead of any binding lookup: a
    // retained row has no query, and a constraint-performed one must not have one.
    if (step.action === 'retain') {
      run.retain(stepKey(step));
      continue;
    }
    if (step.action === 'database') {
      run.database(stepKey(step));
      continue;
    }
    const binding = STEP_BINDINGS[bindingKey(step)];
    if (!binding) {
      run.fail(
        bindingKey(step),
        new Error(`no Postgres binding for cascade step ${bindingKey(step)}`),
      );
      continue;
    }
    if (isDelegated(binding)) {
      run.delegate(stepKey(step));
      continue;
    }
    if (isInBatch(binding)) {
      inBatch.push({ step, binding });
      continue;
    }
    const bucket = phases.get(binding.phase);
    if (bucket) bucket.push({ step, binding });
    else phases.set(binding.phase, [{ step, binding }]);
  }

  // A stable sort, so an entry without an `order` keeps its manifest position.
  for (const bucket of phases.values()) {
    bucket.sort((left, right) => (left.binding.order ?? 0) - (right.binding.order ?? 0));
  }
  return { phases, inBatch };
}

/**
 * Run every manifest step assigned to one phase.
 *
 * A step that throws still records its key (as 0) so the result stays a complete
 * description of the manifest, and the failure is collected for the throw at the
 * end. A step with NO binding records nothing — the missing key is what the
 * manifest-binding test reports.
 */
export async function runPhase(
  phase: CascadePhase,
  schedule: Schedule,
  targets: DeletionTargets,
  dryRun: boolean,
  run: CascadeRun,
): Promise<void> {
  for (const { step, binding } of schedule.phases.get(phase) ?? []) {
    try {
      const where = binding.where(targets);
      if (where === undefined) {
        run.record(stepKey(step), 0);
        continue;
      }
      if (dryRun) {
        run.record(stepKey(step), await countRows(binding.table, where));
      } else if (binding.update) {
        run.record(stepKey(step), await binding.update(targets, where));
      } else {
        run.record(stepKey(step), await countOrDelete(binding.table, where, false));
      }
    } catch (error) {
      run.record(stepKey(step), 0);
      run.fail(stepKey(step), error);
    }
  }
}
