import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';
import { logger } from '../../utils/logger';
import ExternalFeed from '../../models/ExternalFeed';
import { xrpcGet } from './xrpcClient';
import { BSKY_APP_ORIGIN, FEED_GENERATOR_COLLECTION, PUBLIC_APPVIEW } from './constants';

/**
 * Mirrors a Bluesky actor's FEED GENERATORS (`app.bsky.feed.generator`) into
 * Mention's `ExternalFeed` collection as READ-ONLY references.
 *
 * A Bluesky feed is a remote algorithmic SERVICE (`view.did` is a `did:web:` host
 * that runs the ranking) — Mention CANNOT execute it, so this deliberately does
 * NOT build a runnable Mention feed (`CustomFeed`/`FeedGenerator`). It stores only
 * display metadata + a `webUrl` deep link so a synced profile can surface "feeds
 * created by this user" as reference cards that open on Bluesky. Deduped on the
 * feed's AT-URI; re-sync refreshes metadata in place.
 */

/** Max feed references mirrored per actor in one sync (a single AppView page). */
const MAX_FEEDS_PER_ACTOR = 50;

/** A `generatorView` from `app.bsky.feed.getActorFeeds` (only the read fields). */
interface AtprotoGeneratorView {
  /** The feed generator's AT-URI (`at://<creatorDid>/app.bsky.feed.generator/<rkey>`). */
  uri?: string;
  /** The DID of the remote service that RUNS the algorithm (never executed here). */
  did?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  likeCount?: number;
  creator?: { did?: string; handle?: string };
}

interface AtprotoGetActorFeedsResponse {
  feeds?: AtprotoGeneratorView[];
  cursor?: string;
}

/** A feed generator reduced to the read-only reference fields Mention stores. */
export interface NormalizedExternalFeed {
  uri: string;
  serviceDid: string;
  name: string;
  description?: string;
  avatar?: string;
  likeCount: number;
  webUrl: string;
}

/** Parse `at://<authority>/<collection>/<rkey>` into its parts. Pure. */
function parseAtUri(uri: string): { authority: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { authority: match[1], collection: match[2], rkey: match[3] };
}

/**
 * Map a `getActorFeeds` generator view to a read-only external feed reference.
 * Returns null for anything that is not a feed generator AT-URI or is missing the
 * service DID / a display name. Pure.
 */
export function mapGeneratorToExternalFeed(view: AtprotoGeneratorView | undefined): NormalizedExternalFeed | null {
  if (!view) return null;
  const uri = typeof view.uri === 'string' ? view.uri : '';
  const parsed = parseAtUri(uri);
  if (!parsed || parsed.collection !== FEED_GENERATOR_COLLECTION) return null;

  const serviceDid = typeof view.did === 'string' ? view.did : '';
  const name = typeof view.displayName === 'string' ? normalizeInlineText(view.displayName) : '';
  if (!serviceDid || !name) return null;

  const description = typeof view.description === 'string' ? normalizeMultilineText(view.description) : '';
  // Prefer the creator's handle for a human-friendly deep link; fall back to the
  // AT-URI authority (the creator DID) which bsky.app also resolves.
  const creatorRef =
    (typeof view.creator?.handle === 'string' && view.creator.handle) || parsed.authority;
  const webUrl = `${BSKY_APP_ORIGIN}/profile/${creatorRef}/feed/${parsed.rkey}`;

  return {
    uri,
    serviceDid,
    name,
    description: description || undefined,
    avatar: typeof view.avatar === 'string' && view.avatar ? view.avatar : undefined,
    likeCount: typeof view.likeCount === 'number' ? view.likeCount : 0,
    webUrl,
  };
}

/**
 * Sync an atproto actor's feed generators into `ExternalFeed` as read-only
 * references. `ownerOxyUserId` is the ALREADY-RESOLVED Oxy user who created the
 * feeds. Best-effort + bounded (a single capped AppView page); returns the number
 * of references upserted; never throws.
 */
export async function syncActorFeeds(did: string, ownerOxyUserId: string): Promise<number> {
  if (!ownerOxyUserId) {
    logger.warn(`[atproto] syncActorFeeds called for ${did} without a resolved Oxy owner; skipping`);
    return 0;
  }

  let response: AtprotoGetActorFeedsResponse;
  try {
    response = await xrpcGet<AtprotoGetActorFeedsResponse>(PUBLIC_APPVIEW, 'app.bsky.feed.getActorFeeds', {
      actor: did,
      limit: MAX_FEEDS_PER_ACTOR,
    });
  } catch (err) {
    logger.debug(`[atproto] getActorFeeds failed for ${did}`, err);
    return 0;
  }

  const views = Array.isArray(response?.feeds) ? response.feeds.slice(0, MAX_FEEDS_PER_ACTOR) : [];
  let upserted = 0;
  for (const view of views) {
    const feed = mapGeneratorToExternalFeed(view);
    if (!feed) continue;
    try {
      await ExternalFeed.findOneAndUpdate(
        { uri: feed.uri },
        {
          $set: {
            network: 'atproto',
            ownerOxyUserId,
            serviceDid: feed.serviceDid,
            name: feed.name,
            description: feed.description,
            avatar: feed.avatar,
            likeCount: feed.likeCount,
            webUrl: feed.webUrl,
            syncedAt: new Date(),
          },
        },
        { upsert: true },
      );
      upserted += 1;
    } catch (err) {
      // A concurrent sync racing the same feed to an E11000 is benign; log + skip.
      logger.warn(`[atproto] failed to upsert external feed ${feed.uri}`, err);
    }
  }

  if (upserted > 0) logger.info(`[atproto] mirrored ${upserted} external feed references for ${did}`);
  return upserted;
}
