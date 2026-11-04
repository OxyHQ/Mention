/**
 * One-shot repair: store federated direct messages as private mentions.
 *
 * WHY. Until private mentions existed, `mapApVisibility` stored any ActivityPub
 * note that was not publicly addressed as `followers_only` — direct messages
 * included — so a DM to a local user was readable by every local follower of
 * its sender and not by the person it was sent to. `hideFederatedDirectMessages`
 * (this script's first form) moved those to `private`, where only the sender
 * could read them: no longer leaked, but still not delivered.
 *
 * WHAT IT DOES. For every stored ActivityPub post that is `private` (hidden by
 * the first form) or still `followers_only`, it re-fetches the note from its
 * origin and asks the ingest rule (`resolveApAudienceExisting`) who it is for:
 *
 *  - a direct note addressed to at least one local user becomes `direct`, with
 *    its addressees as recipients — the same post a new delivery would store
 *    (no notification is sent for history);
 *  - a followers-addressed note stays `followers_only`;
 *  - a followers-only post whose note is direct to nobody here, or can no longer
 *    be fetched, moves to `private`, as the first form did;
 *  - anything else is left exactly as it is.
 *
 * Addressees resolve against stored identities only, never a fetch: a remote
 * addressee nobody here knows is not a reader here anyway. Nothing is deleted.
 *
 * SAFETY: `DRY_RUN` defaults to true and only counts; a write needs
 * `CONFIRM_ADMIN_MUTATION=recoverFederatedDirectMessages`. Idempotent: a
 * converted or hidden post no longer matches what it was converted from, and
 * every write re-checks the visibility it read.
 *
 *   bun packages/backend/dist/src/scripts/recoverFederatedDirectMessages.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=recoverFederatedDirectMessages \
 *     bun packages/backend/dist/src/scripts/recoverFederatedDirectMessages.js
 */

import { PostVisibility } from '@mention/shared-types';
import { and, asc, eq, gt, inArray, like } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { findActorByUri } from '../db/federation/actorRepository';
import { convertToDirectPost } from '../db/posts/postAudience';
import { fetchActivityPubObject } from '../connectors/activitypub/helpers';
import { resolveApAudienceExisting } from '../connectors/activitypub/apMentions';
import { invalidate as invalidatePostDetailCache } from '../services/postDetailCache';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'recoverFederatedDirectMessages';
const BATCH = 200;

export interface RecoverDirectMessagesResult {
  /** Private and followers-only ActivityPub posts examined. */
  scanned: number;
  /** Direct notes to a local user: converted to `direct` (or would be, dry). */
  converted: number;
  /** Followers-addressed notes, left followers-only. */
  followersOnly: number;
  /** Followers-only posts that are not followers-addressed: moved to private. */
  hidden: number;
  /** Posts left as they are (still private, or no longer followers-only). */
  unchanged: number;
  /** Notes that could not be fetched again. */
  unfetchable: number;
}

export async function recoverFederatedDirectMessages(options: {
  dryRun: boolean;
}): Promise<RecoverDirectMessagesResult> {
  const result: RecoverDirectMessagesResult = {
    scanned: 0,
    converted: 0,
    followersOnly: 0,
    hidden: 0,
    unchanged: 0,
    unfetchable: 0,
  };
  const followersUrlByActor = new Map<string, string | undefined>();

  let after = '';
  for (;;) {
    const rows = await getDb()
      .select({
        id: posts.id,
        visibility: posts.visibility,
        activityId: posts.federationActivityId,
        actorUri: posts.federationActorUri,
      })
      .from(posts)
      .where(
        and(
          inArray(posts.visibility, [PostVisibility.PRIVATE, PostVisibility.FOLLOWERS_ONLY]),
          like(posts.federationActivityId, 'http%'),
          after ? gt(posts.id, after) : undefined,
        ),
      )
      .orderBy(asc(posts.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      if (!row.activityId || !row.actorUri) continue;
      result.scanned += 1;
      const stored = row.visibility as PostVisibility;
      const note = await fetchActivityPubObject(row.activityId);
      if (!note) result.unfetchable += 1;

      if (!followersUrlByActor.has(row.actorUri)) {
        followersUrlByActor.set(row.actorUri, (await findActorByUri(row.actorUri))?.followersUrl);
      }
      const audience = note
        ? await resolveApAudienceExisting(note, {
            uri: row.actorUri,
            followersUrl: followersUrlByActor.get(row.actorUri),
          })
        : null;

      if (audience?.visibility === PostVisibility.DIRECT) {
        result.converted += 1;
        if (!options.dryRun && (await convertToDirectPost(row.id, stored, audience.recipients))) {
          await invalidatePostDetailCache(row.id);
        }
      } else if (audience?.visibility === PostVisibility.FOLLOWERS_ONLY) {
        result.followersOnly += 1;
      } else if (
        stored === PostVisibility.FOLLOWERS_ONLY &&
        audience?.visibility !== PostVisibility.PUBLIC
      ) {
        result.hidden += 1;
        if (!options.dryRun) {
          const updated = await getDb()
            .update(posts)
            .set({ visibility: PostVisibility.PRIVATE })
            .where(and(eq(posts.id, row.id), eq(posts.visibility, PostVisibility.FOLLOWERS_ONLY)))
            .returning({ id: posts.id });
          if (updated.length > 0) await invalidatePostDetailCache(row.id);
        }
      } else {
        result.unchanged += 1;
      }
    }
  }

  logger.info(`[${SCRIPT_NAME}] complete`, { ...options, ...result });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await recoverFederatedDirectMessages({ dryRun });
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
