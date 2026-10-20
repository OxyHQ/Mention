/**
 * The Oxy file-reference reconciliation, run once on demand
 * (`.github/workflows/run-file-reference-reconciliation.yml`;
 * `docs/oxy-files.md` § Rollout).
 *
 * WHY. The nightly run (`fileReferenceReconciliation.ts`) only starts between
 * 02:00 and 06:00 UTC and always applies. Here an operator previews it (a dry
 * run, the default) or applies it without waiting for the night — as the
 * rollout made the first applied run, the backfill of every existing post,
 * banner and GIF into Oxy's model. This runs the SAME function, so what it records in
 * `oxy_file_reference_reconciliations` is what the nightly run records; the
 * nightly scheduler counts it as that night's run.
 *
 * SAFETY:
 *  1. `MODE` defaults to `dry_run`: Oxy reports what each entity type WOULD
 *     add and remove and commits nothing.
 *  2. `MODE=apply` is refused until the operator names the script back
 *     (`assertAdminMutationAllowed`).
 *  3. Oxy holds one session per entity type, so a run racing the nightly one
 *     fails that entity type (409) instead of interleaving with it.
 *  4. Any entity type that did not complete fails the run (non-zero exit).
 *
 *   bun packages/backend/dist/src/scripts/reconcileOxyFileReferences.js
 *   MODE=apply CONFIRM_ADMIN_MUTATION=reconcileOxyFileReferences \
 *     bun packages/backend/dist/src/scripts/reconcileOxyFileReferences.js
 */

import { connectPostgres } from '../db/postgres';
import {
  runFileReferenceReconciliation,
  type ReconcileMode,
} from '../services/oxyFiles/fileReferenceReconciliation';
import { logger } from '../utils/logger';
import { assertAdminRunComplete, closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'reconcileOxyFileReferences';

/** `MODE`, read positively: anything but the two names stops the run. */
export function parseReconcileMode(value: string | undefined): ReconcileMode {
  const mode = (value ?? 'dry_run').trim();
  if (mode === 'dry_run' || mode === 'apply') return mode;
  throw new Error(`[${SCRIPT_NAME}] MODE must be dry_run or apply (got '${mode}')`);
}

async function main(): Promise<void> {
  const mode = parseReconcileMode(process.env.MODE);
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun: mode === 'dry_run' });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { mode });

  const result = await runFileReferenceReconciliation(mode);

  for (const entry of result.entityTypes) {
    logger.info(`[${SCRIPT_NAME}] entity type`, { ...entry });
  }
  const sum = (key: 'items' | 'added' | 'removed' | 'unchanged' | 'refused' | 'replayed') =>
    result.entityTypes.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  const failed = result.entityTypes.filter((entry) => !entry.ok);
  logger.info(`[${SCRIPT_NAME}] complete`, {
    runId: result.runId,
    mode,
    entityTypes: result.entityTypes.length,
    items: sum('items'),
    added: sum('added'),
    removed: sum('removed'),
    unchanged: sum('unchanged'),
    refused: sum('refused'),
    replayed: sum('replayed'),
    failed: failed.length,
    failures: failed.map((entry) => `${entry.oxyEntityType}: ${entry.error}`),
  });
  assertAdminRunComplete(SCRIPT_NAME, { failedEntityTypes: failed.length });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
