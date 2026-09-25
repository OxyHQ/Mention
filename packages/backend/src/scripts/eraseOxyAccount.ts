/**
 * Erase one Oxy account's Mention data by hand (OxyHQ/Mention#1169).
 *
 * For accounts deleted in Oxy BEFORE the account-event webhook existed, which
 * therefore never produced an event Mention could receive (the issue's
 * `01a0d834-b80a-7cbd-b416-5502d33318c9` is one). Anything deleted after it
 * shipped arrives on its own; this is not the normal path.
 *
 * It goes through exactly the same code as an Oxy event: a row in
 * `account_erasures` (event id `operator:<oxy user id>`, so a re-run resumes the
 * same row instead of starting another), then `processAccountErasure`.
 *
 * SAFETY
 *  - Dry run by default: prints what WOULD be erased, per category, and writes
 *    nothing. Always run it first.
 *  - A live run needs `CONFIRM_ADMIN_MUTATION=eraseOxyAccount`.
 *  - It REFUSES an account Oxy still resolves as active. A deletion is never
 *    inferred, but an operator erasing a live person's data by typo is the one
 *    mistake this script can make, so it asks Oxy first. A 404 (deleted) or an
 *    `archived` account (deleted, financial records retained) proceeds; anything
 *    else, including Oxy being unreachable, stops.
 *
 * ENVIRONMENT
 *   ERASE_OXY_USER_ID   required  the Oxy account id
 *   ERASE_USERNAME      optional  the handle at deletion time, so the fediverse
 *                                 can be sent Deletes (Oxy no longer knows it)
 *   ERASE_DRY_RUN       default true
 *
 * Run in production through `.github/workflows/run-account-erasure.yml` (an ECS
 * one-shot inside the VPC), never from a workstation.
 */

import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { connectPostgres } from '../db/postgres';
import { recordAccountErasureRequest } from '../db/accountErasures/accountErasureRepository';
import {
  previewAccountErasure,
  processAccountErasure,
} from '../services/accountErasure/AccountErasureService';
import { normalizeUsername } from '../services/accountErasure/oxyAccountEvents';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';

export const SCRIPT_NAME = 'eraseOxyAccount';

/** What Oxy says about the account. Only `deleted` and `archived` may be erased. */
export type OxyAccountState = 'deleted' | 'archived' | 'active' | 'unknown';

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = Reflect.get(error, 'status') ?? Reflect.get(error, 'statusCode');
  return typeof status === 'number' ? status : undefined;
}

export async function readOxyAccountState(oxyUserId: string): Promise<OxyAccountState> {
  try {
    const user: unknown = await getServiceOxyClient().getUserById(oxyUserId);
    if (!user) return 'deleted';
    const accountStatus = typeof user === 'object' ? Reflect.get(user, 'accountStatus') : undefined;
    return accountStatus === 'archived' ? 'archived' : 'active';
  } catch (error) {
    return statusOf(error) === 404 ? 'deleted' : 'unknown';
  }
}

export interface EraseOptions {
  oxyUserId: string;
  username: string | null;
  dryRun: boolean;
}

export async function runOperatorErasure(options: EraseOptions): Promise<Record<string, unknown>> {
  const state = await readOxyAccountState(options.oxyUserId);
  if (state === 'active' || state === 'unknown') {
    throw new Error(
      `[${SCRIPT_NAME}] refused: Oxy reports the account as ${state}. Only an account Oxy has ` +
        'deleted (404) or archived may be erased by hand.',
    );
  }

  if (options.dryRun) {
    const preview = await previewAccountErasure(options.oxyUserId);
    return { dryRun: true, oxyState: state, federated: options.username !== null, preview };
  }

  const eventId = `operator:${options.oxyUserId}`;
  await recordAccountErasureRequest({
    eventId,
    oxyUserId: options.oxyUserId,
    source: 'operator',
    reason: 'account.deleted',
    occurredAt: null,
    retained: state === 'archived',
    username: options.username,
  });
  const outcome = await processAccountErasure(eventId);
  return { dryRun: false, oxyState: state, eventId, ...outcome };
}

async function main(): Promise<void> {
  const oxyUserId = process.env.ERASE_OXY_USER_ID?.trim() ?? '';
  if (!oxyUserId) throw new Error(`[${SCRIPT_NAME}] ERASE_OXY_USER_ID is required`);
  const dryRun = (process.env.ERASE_DRY_RUN ?? 'true') !== 'false';
  const rawUsername = process.env.ERASE_USERNAME;
  const username = normalizeUsername(rawUsername);
  if (rawUsername && rawUsername.trim() && !username) {
    throw new Error(`[${SCRIPT_NAME}] ERASE_USERNAME is not a plain handle`);
  }

  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  const result = await runOperatorErasure({ oxyUserId, username, dryRun });
  // Counts only; nothing here is content.
  logger.info(`[${SCRIPT_NAME}] ${dryRun ? 'dry run' : 'erasure'} finished`, result);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources();
      process.exit(1);
    });
}
