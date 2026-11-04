/**
 * One-shot: give every existing follow of a federated person the follows of
 * that person's OTHER transports, as a new follow gets (`connectors/transportFollows.ts`).
 * Someone who followed `@pabloiglesias@x.com` through mastox.eu before a follow
 * meant every transport is subscribed to bird.makeup too, so retweets arrive as
 * boosts; existing follows are kept as they are.
 *
 * HOW IT WALKS. Every outbound follow (`accepted` or `pending`), by primary key;
 * the transports of each page's actors from ONE Oxy lookup (`externalIdentities`,
 * same `canonicalAcct`); a transport the follower does not follow yet — or
 * follows only as `pending`, never accepted — is missing. Each Follow is in the
 * delivery queue before the script moves on (`durable`), since the script exits
 * when it is done. Followers who turned fediverse sharing off are skipped, as the
 * follow route refuses them.
 *
 * SAFETY: `DRY_RUN` defaults to `true` (counts only, sends nothing);
 * `assertAdminMutationAllowed` refuses a write until the operator names the
 * script back; idempotent (a sent follow is a follow row, so a re-run skips it).
 *
 *   bun packages/backend/dist/src/scripts/followAccountTransports.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=followAccountTransports \
 *     bun packages/backend/dist/src/scripts/followAccountTransports.js
 */

import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedFollows } from '../db/schema/federation';
import { lookupOxyIdentities } from '../connectors/oxyIdentity';
import {
  backfillFollowedTransport,
  followTransport,
  otherTransportsIn,
  resolveTargetConnector,
} from '../connectors/transportFollows';
import { isFediverseSharingEnabled } from '../services/fediverseSharing';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'followAccountTransports';
/** Follows per page; also the Oxy lookup's limit of 100 identifiers. */
const PAGE = 100;

export interface FollowAccountTransportsResult {
  follows: number;
  /** Follows of an actor Oxy lists other transports for. */
  withOtherTransports: number;
  /** Transport follows missing — sent on a write. */
  missing: number;
  sent: number;
  failed: number;
  sharingDisabled: number;
}

export async function followAccountTransports(
  opts: { dryRun?: boolean } = {},
): Promise<FollowAccountTransportsResult> {
  const dryRun = opts.dryRun ?? true;
  const result: FollowAccountTransportsResult = {
    follows: 0,
    withOtherTransports: 0,
    missing: 0,
    sent: 0,
    failed: 0,
    sharingDisabled: 0,
  };
  const usernames = new Map<string, string | null>();

  let after = '';
  for (;;) {
    const page = await getDb()
      .select({
        id: federatedFollows.id,
        localUserId: federatedFollows.localUserId,
        actorUri: federatedFollows.remoteActorUri,
      })
      .from(federatedFollows)
      .where(
        and(
          eq(federatedFollows.direction, 'outbound'),
          inArray(federatedFollows.status, ['accepted', 'pending']),
          gt(federatedFollows.id, after),
        ),
      )
      .orderBy(asc(federatedFollows.id))
      .limit(PAGE);
    if (page.length === 0) break;
    after = page[page.length - 1].id;

    const identities = await lookupOxyIdentities([...new Set(page.map((row) => row.actorUri))]);
    // Only an ACCEPTED transport follow is present: one still pending was
    // never answered, and is sent again (a Follow is idempotent at the remote).
    const followed = new Set(
      (
        await getDb()
          .select({
            localUserId: federatedFollows.localUserId,
            uri: federatedFollows.remoteActorUri,
          })
          .from(federatedFollows)
          .where(
            and(
              eq(federatedFollows.direction, 'outbound'),
              eq(federatedFollows.status, 'accepted'),
              inArray(federatedFollows.localUserId, [
                ...new Set(page.map((row) => row.localUserId)),
              ]),
            ),
          )
      ).map((row) => `${row.localUserId} ${row.uri}`),
    );

    for (const follow of page) {
      result.follows += 1;
      const others = otherTransportsIn(
        identities.find((entry) => entry.identifier === follow.actorUri),
        follow.actorUri,
      );
      if (others.length === 0) continue;
      result.withOtherTransports += 1;
      const missing = others.filter((uri) => !followed.has(`${follow.localUserId} ${uri}`));
      result.missing += missing.length;
      if (dryRun || missing.length === 0) continue;

      if (!(await isFediverseSharingEnabled(follow.localUserId))) {
        result.sharingDisabled += 1;
        continue;
      }
      if (!usernames.has(follow.localUserId)) {
        const user = await getServiceOxyClient().users.get(follow.localUserId);
        usernames.set(follow.localUserId, user?.username ?? null);
      }
      const username = usernames.get(follow.localUserId);
      if (!username) {
        result.failed += missing.length;
        continue;
      }
      for (const uri of missing) {
        try {
          const connector = await resolveTargetConnector(uri);
          if (!connector) throw new Error('no connector');
          await followTransport({ oxyUserId: follow.localUserId, username }, uri, connector, {
            durable: true,
          });
          backfillFollowedTransport(connector, uri);
          followed.add(`${follow.localUserId} ${uri}`);
          result.sent += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn(`[${SCRIPT_NAME}] a transport follow failed`, {
            reason: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }
  }

  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  const result = await followAccountTransports({ dryRun });
  process.exitCode = result.failed > 0 ? 1 : 0;
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(process.exitCode ?? 0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
