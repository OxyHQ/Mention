/**
 * One-shot repair: Instagram posts imported through the Graph API whose Reel /
 * video slot was stored as its POSTER IMAGE although Meta gave the video.
 *
 * WHY THEY EXIST. Until this fix the importer let a video slot fall back to its
 * poster on ANY failure, including ones that pass — on 2026-09-27 Oxy's
 * media-write budget was spent ("Oxy media store upload budget is spent for
 * this window") while accounts were being imported, and their Reels were stored
 * as still images. The next sync saw each post as imported, so the video never
 * came. The importer now makes such a post wait instead (see
 * `materializeInstagramMedia`); this puts the video into the posts already
 * stored.
 *
 * WHAT IT DOES. For every actor the Graph sync has synced, it walks the media
 * listing newest-first (at most `REPAIR_DEPTH` items per actor, default 100)
 * with the BACKGROUND Graph budget, and for each listed item that this app
 * imported through the Graph API (`posts.federation_activity_id` is its source
 * key) compares the stored media with what Meta lists NOW:
 *
 *  - a slot Meta lists as a VIDEO with a `media_url`, stored as an IMAGE, at
 *    the same position of a post whose slot count matches → a candidate;
 *  - a Reel Meta lists WITHOUT `media_url` (licensed audio) is planned as its
 *    thumbnail by the importer too, so it is never a candidate: its image IS
 *    the correct shape.
 *
 * A candidate's video is re-hosted (`persistOne`, the importer's own path) and
 * swapped in with `replacePostContent`, which also queues the replaced poster
 * file for deletion (it re-checks references first). Metadata enrichment is
 * scheduled for the post. A video that still cannot be stored is left as it is
 * (`waiting` — re-run later; `gone` — it never will be, the poster stays).
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`: it lists the candidates (post id, source
 *     key, slot positions) and writes nothing, uploads nothing.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Idempotent: a repaired slot is a video, so it is no longer a candidate.
 *  4. Meta is called with the background budget and stops at a refusal (budget,
 *     rate limit): re-run later, it resumes by re-checking.
 *
 *   bun packages/backend/dist/src/scripts/repairInstagramReelPosters.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=repairInstagramReelPosters \
 *     bun packages/backend/dist/src/scripts/repairInstagramReelPosters.js
 */

import { and, asc, gt, inArray, isNotNull } from 'drizzle-orm';
import type { MediaItem } from '@mention/shared-types';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { postMedia } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { loadPostRecord, replacePostContent } from '../db/posts/postRepository';
import { fetchBusinessDiscovery, type GraphMedia } from '../connectors/instagram/graphClient';
import {
  mapGraphMediaToNormalizedPost,
  type InstagramMappedPost,
} from '../connectors/instagram/media.mapper';
import { igUserIdFromActorUri, instagramUsernameOfActor } from '../connectors/instagram/constants';
import { persistOne } from '../connectors/instagram/importer';
import { enqueueMediaMetadataEnrich } from '../services/mediaMetadataEnrichJob';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'repairInstagramReelPosters';
const ACTOR_BATCH = 100;
const PAGE_SIZE = 25;
const DEFAULT_DEPTH = 100;

export interface ReelPosterCandidate {
  postId: string;
  sourceKey: string;
  /** Positions of `content.media` stored as an image where Meta lists a video. */
  slots: number[];
}

export interface ReelPosterRepairResult {
  actors: number;
  /** Listed items this app imported through the Graph API. */
  checked: number;
  candidates: ReelPosterCandidate[];
  /** Posts whose video slots were all re-hosted and swapped in. Always 0 on a dry run. */
  repaired: number;
  /** Posts with a slot whose video may still store later — re-run. */
  waiting: number;
  /** Posts with a slot whose video can never be stored — the poster stays. */
  gone: number;
  /** Actors whose walk stopped at a Graph refusal (budget, rate limit, not business, identity). */
  stopped: number;
}

/** The stored-vs-listed comparison, pure: which slots are a poster standing in for a listed video. */
export function degradedVideoSlots(
  entry: InstagramMappedPost,
  stored: ReadonlyArray<{ type: string }>,
): number[] {
  const plans = entry.mediaPlans;
  // A dropped slot shifts positions: compare only posts whose shape still lines up.
  if (plans.length === 0 || plans.length !== stored.length) return [];
  return plans.flatMap((plan, index) =>
    plan.primary.type === 'video' && stored[index].type === 'image' ? [index] : [],
  );
}

async function storedMediaByPost(
  postIds: readonly string[],
): Promise<Map<string, Array<{ type: string }>>> {
  const byPost = new Map<string, Array<{ type: string }>>();
  if (postIds.length === 0) return byPost;
  const rows = await getDb()
    .select({ postId: postMedia.postId, type: postMedia.type, position: postMedia.position })
    .from(postMedia)
    .where(inArray(postMedia.postId, [...postIds]))
    .orderBy(asc(postMedia.postId), asc(postMedia.position));
  for (const row of rows) {
    const list = byPost.get(row.postId) ?? [];
    list.push({ type: row.type });
    byPost.set(row.postId, list);
  }
  return byPost;
}

/** Swap the video in for each degraded slot of one post. */
async function repairPost(
  candidate: ReelPosterCandidate,
  entry: InstagramMappedPost,
  owner: string,
  actorUri: string,
): Promise<'repaired' | 'waiting' | 'gone'> {
  const record = await loadPostRecord(candidate.postId);
  if (!record) return 'gone';
  const media = [...(record.content.media ?? [])] as MediaItem[];
  const replacements = new Map<string, MediaItem>();
  for (const slot of candidate.slots) {
    const outcome = await persistOne(entry.mediaPlans[slot].primary, owner, {
      activityId: candidate.sourceKey,
      actorUri,
    });
    if (outcome.kind !== 'stored') return outcome.kind === 'retry' ? 'waiting' : 'gone';
    const previous = media[slot];
    if (previous?.id) replacements.set(previous.id, outcome.media);
    media[slot] = outcome.media;
  }
  const attachments = record.content.attachments?.map((attachment) => {
    if (attachment.type !== 'media') return attachment;
    const next = attachment.id ? replacements.get(attachment.id) : undefined;
    return next ? { ...attachment, id: next.id, mediaType: next.type } : attachment;
  });
  await replacePostContent(
    candidate.postId,
    { ...record.content, media, attachments },
    record.mentions,
  );
  await enqueueMediaMetadataEnrich(candidate.postId).catch(() => false);
  return 'repaired';
}

export async function repairInstagramReelPosters(options: {
  dryRun: boolean;
  depth?: number;
}): Promise<ReelPosterRepairResult> {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const result: ReelPosterRepairResult = {
    actors: 0,
    checked: 0,
    candidates: [],
    repaired: 0,
    waiting: 0,
    gone: 0,
    stopped: 0,
  };

  let after = '';
  for (;;) {
    const actors = await getDb()
      .select()
      .from(federatedActors)
      .where(
        and(
          isNotNull(federatedActors.instagramGraphSyncedAt),
          isNotNull(federatedActors.oxyUserId),
          gt(federatedActors.id, after),
        ),
      )
      .orderBy(asc(federatedActors.id))
      .limit(ACTOR_BATCH);
    if (actors.length === 0) break;
    after = actors[actors.length - 1].id;

    for (const actor of actors) {
      const username = instagramUsernameOfActor(actor);
      const owner = actor.oxyUserId;
      if (!username || !owner) continue;
      result.actors += 1;
      const expectedIgUserId =
        actor.instagramGraphUserId ??
        (actor.protocol === 'instagram-graph' ? igUserIdFromActorUri(actor.uri) : undefined);

      let seen = 0;
      let cursor: string | undefined;
      while (seen < depth) {
        let items: GraphMedia[];
        try {
          const page = await fetchBusinessDiscovery(username, {
            kind: 'background',
            media: { limit: Math.min(PAGE_SIZE, depth - seen), after: cursor },
          });
          if (expectedIgUserId && page.id !== expectedIgUserId) {
            // The username now names a different Instagram account: nothing of it is ours.
            throw new Error('username resolves to a different Instagram account');
          }
          items = page.media?.data ?? [];
          cursor = page.media?.after;
        } catch (err) {
          result.stopped += 1;
          logger.warn(`[${SCRIPT_NAME}] walk stopped`, {
            actor: actor.id,
            reason: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        seen += items.length;

        const mapped = items
          .map((item) => mapGraphMediaToNormalizedPost(item, actor.uri))
          .filter((entry): entry is InstagramMappedPost => entry !== null);
        const keys = mapped.map((entry) => entry.post.activityId);
        const imported =
          keys.length === 0
            ? []
            : await getDb()
                .select({ id: posts.id, key: posts.federationActivityId })
                .from(posts)
                .where(inArray(posts.federationActivityId, keys));
        const postIdByKey = new Map(imported.map((row) => [row.key as string, row.id]));
        const stored = await storedMediaByPost(imported.map((row) => row.id));

        for (const entry of mapped) {
          const postId = postIdByKey.get(entry.post.activityId);
          if (!postId) continue;
          result.checked += 1;
          const slots = degradedVideoSlots(entry, stored.get(postId) ?? []);
          if (slots.length === 0) continue;
          const candidate = { postId, sourceKey: entry.post.activityId, slots };
          result.candidates.push(candidate);
          logger.info(`[${SCRIPT_NAME}] candidate`, { dryRun: options.dryRun, ...candidate });
          if (options.dryRun) continue;
          const outcome = await repairPost(candidate, entry, owner, actor.uri);
          result[outcome] += 1;
        }

        if (!cursor || items.length === 0) break;
      }
    }
  }

  logger.info(`[${SCRIPT_NAME}] complete`, {
    dryRun: options.dryRun,
    ...result,
    candidates: result.candidates.length,
  });
  return result;
}

/** The exit code of a run that finished with work left over (re-run later) — not a failure. */
export const EXIT_INCOMPLETE = 75;

/**
 * 0 when the run reached everything it set out to check; {@link EXIT_INCOMPLETE}
 * when an actor's walk stopped at a Graph refusal (budget, rate limit) or a
 * video could not be stored yet — the one-shot workflow reports that as
 * "re-run", not as a failure.
 */
export function reelPosterRepairExitCode(
  result: Pick<ReelPosterRepairResult, 'stopped' | 'waiting'>,
): number {
  return result.stopped > 0 || result.waiting > 0 ? EXIT_INCOMPLETE : 0;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  const depth = Number(process.env.REPAIR_DEPTH ?? DEFAULT_DEPTH);
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun, depth });
  const result = await repairInstagramReelPosters({
    dryRun,
    depth: Number.isFinite(depth) && depth > 0 ? depth : DEFAULT_DEPTH,
  });
  process.exitCode = reelPosterRepairExitCode(result);
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
