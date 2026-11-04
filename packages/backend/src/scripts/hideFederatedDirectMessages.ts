/**
 * One-shot repair: hide federated direct messages stored as followers-only.
 *
 * WHY. Until the ingest paths learned to drop them, `mapApVisibility` stored any
 * ActivityPub note that was not publicly addressed as `followers_only` — direct
 * messages and limited-audience notes included. A DM that mentioned a local
 * user was therefore readable by every local follower of its sender, and not by
 * the person it was sent to unless they also followed the sender.
 *
 * WHAT IT DOES. For every stored ActivityPub post that is `followers_only`, it
 * re-fetches the note from its origin and keeps it only when it is addressed to
 * its author's followers collection (`mapApVisibility`, the ingest rule). Any
 * other answer — a direct or limited audience, or a note that can no longer be
 * fetched — moves the post to `private`, which nobody but its owner can read.
 * Nothing is deleted, so a mistaken hide is one UPDATE away from undone.
 *
 * SAFETY: `DRY_RUN` defaults to true and only counts; a write needs
 * `CONFIRM_ADMIN_MUTATION=hideFederatedDirectMessages`. Idempotent: a hidden
 * post is no longer `followers_only`, so a re-run never revisits it.
 *
 *   bun packages/backend/dist/src/scripts/hideFederatedDirectMessages.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=hideFederatedDirectMessages \
 *     bun packages/backend/dist/src/scripts/hideFederatedDirectMessages.js
 */

import { PostVisibility } from '@mention/shared-types';
import { and, asc, eq, gt, like } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { findActorByUri } from '../db/federation/actorRepository';
import { fetchActivityPubObject, mapApVisibility } from '../connectors/activitypub/helpers';
import { invalidate as invalidatePostDetailCache } from '../services/postDetailCache';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'hideFederatedDirectMessages';
const BATCH = 200;

export interface HideDirectMessagesResult {
  /** Followers-only ActivityPub posts examined. */
  scanned: number;
  /** Confirmed addressed to the author's followers: left as they are. */
  followersOnly: number;
  /** Not addressed to the author's followers (DM / limited audience). */
  directOrLimited: number;
  /** The note could not be fetched again. */
  unfetchable: number;
  /** Moved to private. Always 0 on a dry run. */
  hidden: number;
}

export async function hideFederatedDirectMessages(options: {
  dryRun: boolean;
}): Promise<HideDirectMessagesResult> {
  const result: HideDirectMessagesResult = {
    scanned: 0,
    followersOnly: 0,
    directOrLimited: 0,
    unfetchable: 0,
    hidden: 0,
  };
  const followersUrlByActor = new Map<string, string | undefined>();

  let after = '';
  for (;;) {
    const rows = await getDb()
      .select({
        id: posts.id,
        activityId: posts.federationActivityId,
        actorUri: posts.federationActorUri,
      })
      .from(posts)
      .where(
        and(
          eq(posts.visibility, PostVisibility.FOLLOWERS_ONLY),
          like(posts.federationActivityId, 'http%'),
          after ? gt(posts.id, after) : undefined,
        ),
      )
      .orderBy(asc(posts.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      if (!row.activityId) continue;
      result.scanned += 1;
      const note = await fetchActivityPubObject(row.activityId);
      let keep = false;
      if (!note) {
        result.unfetchable += 1;
      } else {
        const actorUri = row.actorUri ?? '';
        if (!followersUrlByActor.has(actorUri)) {
          followersUrlByActor.set(actorUri, (await findActorByUri(actorUri))?.followersUrl);
        }
        keep =
          mapApVisibility(note.to, note.cc, followersUrlByActor.get(actorUri)) ===
          PostVisibility.FOLLOWERS_ONLY;
        if (keep) result.followersOnly += 1;
        else result.directOrLimited += 1;
      }
      if (keep || options.dryRun) continue;
      const updated = await getDb()
        .update(posts)
        .set({ visibility: PostVisibility.PRIVATE })
        .where(and(eq(posts.id, row.id), eq(posts.visibility, PostVisibility.FOLLOWERS_ONLY)))
        .returning({ id: posts.id });
      if (updated.length > 0) {
        result.hidden += 1;
        await invalidatePostDetailCache(row.id);
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
  await hideFederatedDirectMessages({ dryRun });
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
