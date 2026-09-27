import { PostVisibility, type MediaItem } from '@mention/shared-types';
import type { NormalizedExternalMedia, NormalizedExternalPost } from '@oxy.so/federation';
import { isUniqueViolation } from '@oxy.so/db';
import { inArray, or } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { getPostCreator } from '../../services/serviceRegistry';
import { logger } from '../../utils/logger';
import { materializeFederatedMedia, type ExtractedMediaAttachment } from '../shared/federatedMedia';
import { kilogramNoteIdFor } from '../shared/instagramSourceKey';
import { GRAPH_MEDIA_PAGE_SIZE, INSTAGRAM_IDENTITY_DOMAIN } from './constants';
import {
  fetchBusinessDiscovery,
  InstagramGraphError,
  type GraphBusinessProfile,
  type GraphMedia,
} from './graphClient';
import { mapGraphMediaToNormalizedPost, type InstagramMappedPost, type InstagramMediaPlan } from './media.mapper';
import type { GraphCallKind } from './usageBudget';

/**
 * Import one Instagram account's posts from the Graph API as native posts.
 *
 * Through the SAME `getPostCreator().create` path the ActivityPub and atproto
 * imports use (no notifications, no socket emit, no outbound federation, the
 * original `createdAt`), with the remote media MATERIALIZED at import — Meta's
 * CDN URLs are signed and expire (`oe=`), so a post that kept its remote URL
 * would lose its media within days.
 *
 * Dedupe, strongest first:
 *  1. `posts_source_post_key_key` — the partial UNIQUE index a Graph import and a
 *     kilogram push both write `instagram:<shortcode>` into. A concurrent or
 *     later import of either road collides; the collision is "already here".
 *  2. A pre-read of the keys, plus — for a kilogram-backed actor — the bridge's
 *     Note ids for the same shortcodes, which is how a post ingested from
 *     kilogram BEFORE `source_post_key` existed is recognised.
 */

export interface InstagramImportTarget {
  /** The Instagram username to ask Business Discovery about. */
  username: string;
  /** Every imported post's author. Required: no orphan posts. */
  ownerOxyUserId: string;
  /**
   * `posts.federation_actor_uri` for imported posts: the kilogram actor URI for a
   * bridge-identity account (so identity projection and cross-post detection,
   * both keyed on it, treat the two roads as one source), or `instagram-graph:<id>`.
   */
  actorUri: string;
  /**
   * For an `instagram-graph` actor: the IG user id it was resolved as. A username
   * can be released and re-registered; if Business Discovery now answers with a
   * different id, nothing is imported under the old identity.
   */
  expectedIgUserId?: string;
  /** Set for a kilogram-backed account: its bridge actor URI, for legacy dedupe. */
  kilogramActorUri?: string;
}

export interface InstagramImportOptions {
  /** Maximum posts to inspect, newest first. */
  limit: number;
  /** Stop at the first already-imported post (the periodic "what's new" sync). */
  stopAtKnown: boolean;
  /** Which budget tier the Graph calls draw from. */
  kind: GraphCallKind;
}

export type InstagramImportOutcome =
  | 'ok'
  | 'identity_mismatch'
  | InstagramGraphError['kind'];

export interface InstagramImportResult {
  outcome: InstagramImportOutcome;
  imported: number;
  /** The posts this run stored, newest first. */
  posts: NormalizedExternalPost[];
  /** Media items the Graph API returned (before dedupe). */
  seen: number;
  profile?: Omit<GraphBusinessProfile, 'media'>;
}

function toMediaItem(item: NormalizedExternalMedia): MediaItem {
  return {
    id: item.id,
    type: item.type,
    ...(item.remoteUrl ? { remoteUrl: item.remoteUrl } : {}),
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
  };
}

function toAttachment(item: NormalizedExternalMedia): ExtractedMediaAttachment {
  return { type: 'media', id: item.id, mediaType: item.type };
}

/**
 * Materialize every slot in order. A slot whose primary is permanently
 * unavailable (a video past the size cap, a 404) falls back to its poster image,
 * so a Reel degrades to its still rather than vanishing from the post.
 */
async function materializePlans(
  plans: readonly InstagramMediaPlan[],
  ownerOxyUserId: string,
  context: { activityId: string; actorUri: string },
): Promise<{ media: MediaItem[]; attachments: ExtractedMediaAttachment[] }> {
  const media: MediaItem[] = [];
  const attachments: ExtractedMediaAttachment[] = [];
  for (const plan of plans) {
    let result = await materializeFederatedMedia([toMediaItem(plan.primary)], [toAttachment(plan.primary)], ownerOxyUserId, context);
    if (result.media.length === 0 && plan.fallback) {
      result = await materializeFederatedMedia([toMediaItem(plan.fallback)], [toAttachment(plan.fallback)], ownerOxyUserId, context);
    }
    media.push(...result.media);
    attachments.push(...result.attachments);
  }
  return { media, attachments };
}

/** The mapped posts already stored, by either road. */
async function findAlreadyImported(
  mapped: readonly InstagramMappedPost[],
  kilogramActorUri: string | undefined,
): Promise<Set<string>> {
  if (mapped.length === 0) return new Set();
  const keys = mapped.map((entry) => entry.post.activityId);
  const kilogramIds = kilogramActorUri
    ? mapped.flatMap((entry) => kilogramNoteIdFor(kilogramActorUri, entry.shortcode) ?? [])
    : [];
  const rows = await getDb()
    .select({ activityId: posts.federationActivityId, sourcePostKey: posts.sourcePostKey })
    .from(posts)
    .where(or(
      inArray(posts.federationActivityId, [...keys, ...kilogramIds]),
      inArray(posts.sourcePostKey, keys),
    ));

  const known = new Set<string>();
  for (const row of rows) {
    if (row.sourcePostKey) known.add(row.sourcePostKey);
    if (row.activityId) known.add(row.activityId);
  }
  // Report by source key, whichever column matched.
  const knownKeys = new Set<string>();
  for (const entry of mapped) {
    const kilogramId = kilogramActorUri ? kilogramNoteIdFor(kilogramActorUri, entry.shortcode) : undefined;
    if (known.has(entry.post.activityId) || (kilogramId && known.has(kilogramId))) {
      knownKeys.add(entry.post.activityId);
    }
  }
  return knownKeys;
}

/** Store one mapped post. True on a fresh insert; false when it already existed. */
async function createInstagramPost(entry: InstagramMappedPost, target: InstagramImportTarget): Promise<boolean> {
  const { post } = entry;
  const materialized = await materializePlans(entry.mediaPlans, target.ownerOxyUserId, {
    activityId: post.activityId,
    actorUri: target.actorUri,
  });

  try {
    await getPostCreator().create({
      oxyUserId: target.ownerOxyUserId,
      federation: {
        activityId: post.activityId,
        actorUri: target.actorUri,
        url: post.url,
        sensitive: false,
        sourcePostKey: post.activityId,
      },
      content: {
        text: post.text,
        media: materialized.media.length > 0 ? materialized.media : undefined,
        attachments: materialized.attachments.length > 0 ? materialized.attachments : undefined,
      },
      visibility: PostVisibility.PUBLIC,
      hashtags: post.hashtags,
      instanceDomain: INSTAGRAM_IDENTITY_DOMAIN,
      status: 'published',
      metadata: { isSensitive: false },
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
      ...(post.createdAt ? { createdAt: post.createdAt, updatedAt: post.createdAt } : {}),
    });
    return true;
  } catch (err) {
    // The other road (or a concurrent import) got there first.
    if (isUniqueViolation(err)) return false;
    logger.warn('[instagram] failed to import post', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Page through the account's media newest-first and import what is new.
 * Never throws: a Graph failure is the result's `outcome`, with whatever the
 * earlier pages already imported counted in `imported`.
 */
export async function importInstagramMedia(
  target: InstagramImportTarget,
  options: InstagramImportOptions,
): Promise<InstagramImportResult> {
  let imported = 0;
  const importedPosts: NormalizedExternalPost[] = [];
  let seen = 0;
  let after: string | undefined;
  let profile: InstagramImportResult['profile'];

  while (seen < options.limit) {
    const pageSize = Math.min(GRAPH_MEDIA_PAGE_SIZE, options.limit - seen);
    let page: GraphBusinessProfile;
    try {
      page = await fetchBusinessDiscovery(target.username, {
        kind: options.kind,
        media: { limit: pageSize, after },
      });
    } catch (err) {
      const outcome = err instanceof InstagramGraphError ? err.kind : 'transport';
      if (outcome !== 'not_business') {
        logger.info('[instagram] Graph import stopped', { outcome, imported });
      }
      return { outcome, imported, posts: importedPosts, seen, profile };
    }

    if (target.expectedIgUserId && page.id !== target.expectedIgUserId) {
      // The username now names a different Instagram account.
      logger.warn('[instagram] username resolves to a different Instagram account; import refused');
      return { outcome: 'identity_mismatch', imported, posts: importedPosts, seen, profile };
    }

    const { media, ...pageProfile } = page;
    profile = pageProfile;
    const items: GraphMedia[] = media?.data ?? [];
    seen += items.length;

    const mapped = items
      .map((item) => mapGraphMediaToNormalizedPost(item, target.actorUri))
      .filter((entry): entry is InstagramMappedPost => entry !== null);
    const known = await findAlreadyImported(mapped, target.kilogramActorUri);

    let reachedKnown = false;
    for (const entry of mapped) {
      if (known.has(entry.post.activityId)) {
        if (options.stopAtKnown) {
          reachedKnown = true;
          break;
        }
        continue;
      }
      if (await createInstagramPost(entry, target)) {
        imported += 1;
        importedPosts.push({ ...entry.post, authorOxyUserId: target.ownerOxyUserId });
      }
    }

    after = media?.after;
    if (reachedKnown || !after || items.length < pageSize) break;
  }

  return { outcome: 'ok', imported, posts: importedPosts, seen, profile };
}
