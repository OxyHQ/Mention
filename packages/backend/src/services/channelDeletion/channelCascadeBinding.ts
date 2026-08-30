/**
 * The VOCABULARY a manifest step is bound to Postgres with: the phases a step
 * can run in, the three shapes a binding can take, and the predicate builders
 * the account-scoped ones are written from.
 *
 * Separated from the table itself so the table stays a table. A step's shape —
 * delegated, in-batch, or an ordinary account/lane-scoped write — is a claim
 * about WHO performs it, and that claim is what the run's four disjoint accounts
 * are derived from.
 */

import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { CascadeStep } from './channelCascadeManifest';
import type { PostReferenceProbeName } from '../../scripts/lib/adminDeletionPreflight';
import type { DeletionTargets, PostBatch } from './channelDeletionTargets';

/**
 * The order the phases run in, and what a crash inside each one leaves behind.
 * Each name is what the executor groups manifest steps by.
 */
export type CascadePhase =
  /** Undelivered outbound activities from the channel. */
  | 'federation-drain'
  /** Rows keyed on the channel's lanes. */
  | 'lanes'
  /** Rows keyed on the channel account. */
  | 'account';

/** A manifest step whose disposition belongs to `services/PostDeletionCascade.ts`. */
export interface DelegatedBinding {
  readonly delegated: true;
  /**
   * The reference the delegate covers, typed `PostReferenceProbeName` so the
   * COMPILER holds the two files together: a probe renamed upstream breaks this
   * build rather than leaving a step delegated to a leg that no longer exists. It
   * is documentation with a gate on it, not a lookup key — the delegate is handed
   * the whole doomed set once and decides its own legs.
   */
  readonly leg: PostReferenceProbeName;
}

/** A manifest step the post-batch loop performs, because it is scoped to a batch. */
export interface InBatchBinding {
  readonly inBatch: true;
  /** Rows affected — counted in a dry run, written in a live one. */
  readonly run: (batch: PostBatch, dryRun: boolean) => Promise<number>;
}

/** An ordinary account- or lane-scoped step. */
export interface LocalStepBinding {
  readonly phase: CascadePhase;
  /**
   * Tiebreaker WITHIN a phase; steps otherwise run in manifest order. Only the
   * lane rows need it, and the reason is on that entry.
   */
  readonly order?: number;
  readonly table: PgTable;
  /** The rows this step affects. `undefined` means "no targets", so nothing runs. */
  readonly where: (targets: DeletionTargets) => SQL | undefined;
  /**
   * The live write. Absent means a plain `DELETE` of the matched rows, which is
   * every `delete-row` and `delete-entry` step; the array and pointer steps supply
   * their own `UPDATE` because the column is not interchangeable between them.
   */
  readonly update?: (targets: DeletionTargets, where: SQL) => Promise<number>;
}

export type StepBinding = DelegatedBinding | InBatchBinding | LocalStepBinding;

export function isDelegated(binding: StepBinding): binding is DelegatedBinding {
  return 'delegated' in binding;
}

export function isInBatch(binding: StepBinding): binding is InBatchBinding {
  return 'inBatch' in binding;
}

/** A manifest entry's identity. `notifications.entityId` appears under two scopes. */
export function bindingKey(step: CascadeStep): string {
  return `${step.table}.${step.column}|${step.scope}`;
}

/** The key a step reports its count under. The two-scope columns share one. */
export function stepKey(step: CascadeStep): string {
  return `${step.table}.${step.column}`;
}

/** `column = <the channel's own id>`. */
export function accountEq(column: PgColumn) {
  return (targets: DeletionTargets): SQL => eq(column, targets.channelOxyUserId);
}

/**
 * Remove ONE value from an array column, keeping the row.
 *
 * `array_remove` rather than a read-modify-write: it is a single statement, so two
 * concurrent cascades cannot lose each other's edit, and it is idempotent — a
 * re-run over a row that no longer contains the value modifies nothing.
 */
export function pullValue(column: PgColumn, targets: DeletionTargets): SQL {
  return sql`array_remove(${column}, ${targets.channelOxyUserId})`;
}

/** Rows whose array column still contains the channel. */
export function arrayContainsAccount(column: PgColumn) {
  return (targets: DeletionTargets): SQL =>
    sql`${column} && ${sql.param([targets.channelOxyUserId])}::text[]`;
}
