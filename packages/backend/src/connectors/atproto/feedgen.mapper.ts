import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';
import { logger } from '../../utils/logger';
import { FeedGenerator } from '../../models/FeedGenerator';
import { xrpcGet } from './xrpcClient';
import { FEED_GENERATOR_COLLECTION, PUBLIC_APPVIEW } from './constants';

/**
 * Mirrors a Bluesky actor's FEED GENERATORS (`app.bsky.feed.generator`) into
 * Mention's NATIVE `FeedGenerator` collection.
 *
 * A Bluesky feed is a remote algorithmic SERVICE (`view.did` is a `did:web:` host
 * that runs the ranking) — Mention cannot execute that algorithm, but it CAN pull
 * its output live and import the results as native posts. So a mirrored generator
 * is a first-class Mention feed the engine serves via the `feedgen|<uri>`
 * descriptor (see `mtn/feed/feeds/FeedGeneratorFeed.ts`), NOT a read-only reference
 * card. It is keyed on the generator's AT-URI (`uri`) and marked atproto-backed
 * (`algorithm:'atproto'` + a `source` subdoc), so re-sync refreshes metadata in
 * place (one row per remote feed) and the feed engine knows to dereference the
 * remote feed for content. Owned by the resolved federated Oxy user (`createdBy`)
 * so a profile "feeds" surface can list them by owner.
 */

/** Max feed generators mirrored per actor in one sync (a single AppView page). */
const MAX_FEEDS_PER_ACTOR = 50;

/** `FeedGenerator.name` schema cap — clamp a long remote name so validation never fails. */
const MAX_NAME_LENGTH = 64;

/** `FeedGenerator.description` schema cap. */
const MAX_DESCRIPTION_LENGTH = 300;

/** A `generatorView` from `app.bsky.feed.getActorFeeds` (only the read fields). */
interface AtprotoGeneratorView {
  /** The feed generator's AT-URI (`at://<creatorDid>/app.bsky.feed.generator/<rkey>`). */
  uri?: string;
  /** The DID of the remote service that RUNS the algorithm (`did:web:…`). */
  did?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  likeCount?: number;
}

interface AtprotoGetActorFeedsResponse {
  feeds?: AtprotoGeneratorView[];
  cursor?: string;
}

/** A feed generator reduced to the fields Mention persists on a `FeedGenerator`. */
export interface NormalizedAtprotoFeedGenerator {
  /** The generator's canonical AT-URI (the dedup key + the feed-engine descriptor id). */
  uri: string;
  /** The DID of the remote service that RUNS the algorithm. */
  serviceDid: string;
  name: string;
  description?: string;
  avatar?: string;
  likeCount: number;
}

/** Parse `at://<authority>/<collection>/<rkey>` into its parts. Pure. */
function parseAtUri(uri: string): { authority: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { authority: match[1], collection: match[2], rkey: match[3] };
}

/**
 * Map a `getActorFeeds` generator view to the normalized FeedGenerator fields.
 * Returns null for anything that is not a feed-generator AT-URI or is missing the
 * service DID / a display name. The name + description are clamped to the schema
 * caps so an over-long remote value can never fail persistence validation. Pure.
 */
export function mapGeneratorView(view: AtprotoGeneratorView | undefined): NormalizedAtprotoFeedGenerator | null {
  if (!view) return null;
  const uri = typeof view.uri === 'string' ? view.uri : '';
  const parsed = parseAtUri(uri);
  if (!parsed || parsed.collection !== FEED_GENERATOR_COLLECTION) return null;

  const serviceDid = typeof view.did === 'string' ? view.did : '';
  const name = typeof view.displayName === 'string'
    ? normalizeInlineText(view.displayName).slice(0, MAX_NAME_LENGTH)
    : '';
  if (!serviceDid || !name) return null;

  const description = typeof view.description === 'string'
    ? normalizeMultilineText(view.description).slice(0, MAX_DESCRIPTION_LENGTH)
    : '';

  return {
    uri,
    serviceDid,
    name,
    description: description || undefined,
    avatar: typeof view.avatar === 'string' && view.avatar ? view.avatar : undefined,
    likeCount: typeof view.likeCount === 'number' ? view.likeCount : 0,
  };
}

/**
 * Sync an atproto actor's feed generators into Mention's `FeedGenerator` collection.
 *
 * `did` is the actor's DID; `ownerOxyUserId` is the ALREADY-RESOLVED Oxy user the
 * generators are owned by (the no-orphan invariant — the caller resolves the profile
 * first). Each generator is upserted on its AT-URI (idempotent — re-sync updates
 * metadata in place, never duplicates; the unique `uri` index is the backstop for a
 * concurrent race) and marked atproto-backed so the feed engine dereferences the
 * remote feed for content. Best-effort + bounded (a single capped AppView page);
 * returns the number of generators upserted; never throws.
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
    const generator = mapGeneratorView(view);
    if (!generator) continue;
    try {
      await FeedGenerator.findOneAndUpdate(
        { uri: generator.uri },
        {
          $set: {
            name: generator.name,
            description: generator.description,
            avatar: generator.avatar,
            // `algorithm` is a required human-readable marker; `source.network`
            // is the authoritative "atproto-backed" flag the feed engine reads.
            algorithm: 'atproto',
            createdBy: ownerOxyUserId,
            likeCount: generator.likeCount,
            source: { network: 'atproto', serviceDid: generator.serviceDid, syncedAt: new Date() },
          },
        },
        { upsert: true },
      );
      upserted += 1;
    } catch (err) {
      // A concurrent sync racing the same generator to an E11000 is benign; log + skip.
      logger.warn(`[atproto] failed to upsert feed generator ${generator.uri}`, err);
    }
  }

  if (upserted > 0) logger.info(`[atproto] mirrored ${upserted} feed generators for ${did}`);
  return upserted;
}
