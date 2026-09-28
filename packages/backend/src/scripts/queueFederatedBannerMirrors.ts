/**
 * One-shot recovery: queue a banner mirror for every federated account whose
 * source advertises a banner but that has none stored.
 *
 * WHY. From #994 (2026-09-13) until the banner sweep existed, no federated
 * account's banner was mirrored at all: the resolve-time mirror went away with
 * the move to Oxy's identity authority, and nothing replaced it. Before that, a
 * banner served with a mislabelled Content-Type (`text/plain`,
 * `binary/octet-stream`, `text/html`) or larger than 10 MB was dropped, with no
 * retry. The live path now records every resolved actor's banner, but an actor
 * nobody resolves again would never get one. This queues them.
 *
 * WHAT IT DOES. It pages `federated_actors` that advertise a banner
 * (`header_url`) and are linked to an Oxy user, by primary key, and records the
 * banner (`recordFederatedBanner`, the live path's own write) for each whose
 * user has no `user_settings.profile_header_image`. The periodic banner sweep
 * then mirrors them (sniffing, re-encoding, retries). With
 * `INCLUDE_EXISTING=true` it records users that already have a banner too (a
 * re-sync: a banner changed at its source since it was mirrored). With
 * `RETRY_FAILED=true` it also makes every `failed` row due NOW, with its backoff
 * reset — for after a fix, rather than waiting out the daily retry.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`: it counts and writes nothing.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Idempotent: recording an unchanged URL is a no-op; a re-run queues
 *     nothing new. It only writes `federated_banner_mirrors` — the downloads
 *     happen in the sweep, at its own pace (50 per 2 minutes).
 *
 *   bun packages/backend/dist/src/scripts/queueFederatedBannerMirrors.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=queueFederatedBannerMirrors \
 *     bun packages/backend/dist/src/scripts/queueFederatedBannerMirrors.js
 */

import { and, asc, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors, federatedBannerMirrors } from '../db/schema/federation';
import { userSettings } from '../db/schema/userProfile';
import { recordFederatedBanner } from '../db/federation/bannerMirrorRepository';
import { isAbsoluteHttpUrl } from '../connectors/shared/url';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'queueFederatedBannerMirrors';
const ACTOR_BATCH = 500;

export interface BannerQueueResult {
  /** Actors advertising an http(s) banner, linked to an Oxy user. */
  actors: number;
  /** Of those, users with no stored banner. */
  withoutBanner: number;
  /** Rows written (new, or the URL changed). Always 0 on a dry run. */
  queued: number;
  /** `failed` rows made due now (`retryFailed`). Always 0 on a dry run; the count on a dry run is in `failedDue`. */
  retried: number;
  /** `failed` rows that `retryFailed` would re-arm. */
  failedDue: number;
}

export async function queueFederatedBannerMirrors(options: {
  dryRun: boolean;
  includeExisting?: boolean;
  retryFailed?: boolean;
}): Promise<BannerQueueResult> {
  const result: BannerQueueResult = { actors: 0, withoutBanner: 0, queued: 0, retried: 0, failedDue: 0 };

  let after = '';
  for (;;) {
    const rows = await getDb()
      .select({
        id: federatedActors.id,
        uri: federatedActors.uri,
        headerUrl: federatedActors.headerUrl,
        oxyUserId: federatedActors.oxyUserId,
        storedBanner: userSettings.profileHeaderImage,
      })
      .from(federatedActors)
      .leftJoin(userSettings, eq(userSettings.oxyUserId, federatedActors.oxyUserId))
      .where(and(
        gt(federatedActors.id, after),
        isNotNull(federatedActors.headerUrl),
        ne(federatedActors.headerUrl, ''),
        isNotNull(federatedActors.oxyUserId),
        ne(federatedActors.oxyUserId, ''),
      ))
      .orderBy(asc(federatedActors.id))
      .limit(ACTOR_BATCH);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      if (!row.headerUrl || !row.oxyUserId || !isAbsoluteHttpUrl(row.headerUrl)) continue;
      result.actors += 1;
      const hasBanner = Boolean(row.storedBanner);
      if (!hasBanner) result.withoutBanner += 1;
      if (hasBanner && !options.includeExisting) continue;
      if (options.dryRun) continue;
      if (await recordFederatedBanner({ oxyUserId: row.oxyUserId, actorUri: row.uri, bannerUrl: row.headerUrl })) {
        result.queued += 1;
      }
    }
  }

  if (options.retryFailed) {
    const [due] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(federatedBannerMirrors)
      .where(eq(federatedBannerMirrors.state, 'failed'));
    result.failedDue = Number(due?.n ?? 0);
    if (!options.dryRun) {
      const rearmed = await getDb()
        .update(federatedBannerMirrors)
        .set({ retryAt: sql`now()`, attempts: 0, leaseUntil: null, updatedAt: new Date() })
        .where(eq(federatedBannerMirrors.state, 'failed'))
        .returning({ oxyUserId: federatedBannerMirrors.oxyUserId });
      result.retried = rearmed.length;
    }
  }

  logger.info(`[${SCRIPT_NAME}] complete`, { ...options, ...result });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  const includeExisting = process.env.INCLUDE_EXISTING === 'true';
  const retryFailed = process.env.RETRY_FAILED === 'true';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun, includeExisting, retryFailed });
  await queueFederatedBannerMirrors({ dryRun, includeExisting, retryFailed });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, { reason: error instanceof Error ? error.message : 'unknown' });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
