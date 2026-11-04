import { and, eq } from 'drizzle-orm';
import { findKnownOxyUserIdsByActorUris } from '../../db/federation/actorRepository';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { materializeEngagementRelationship } from '../../services/PostEngagementCommandService';
import { logger } from '../../utils/logger';
import { isDid, PUBLIC_APPVIEW } from './constants';
import { importAtprotoRepost, importPostViews, type AtprotoPostView } from './post.mapper';
import { xrpcGet } from './xrpcClient';
import { bridgyActorUriForDid } from '../shared/bridgyActor';

/**
 * Who liked, reposted and quoted a Bluesky post, among the accounts KNOWN here
 * (`federated_actors` linked to an Oxy user), written through the same records a
 * native engagement uses so the post's lists and counters need nothing new:
 *
 * - a like through `materializeEngagementRelationship` (the projection an inbound
 *   ActivityPub `Like` takes). `getLikes` does not name the like record, so it is
 *   stored without an origin id; the firehose, which does, keeps it current;
 * - a repost through {@link importAtprotoRepost}, once per booster;
 * - a quote through the ordinary post import ({@link importPostViews}).
 *
 * An account not known here is skipped, never minted: this reads lists of
 * strangers, and an Oxy account per stranger is exactly what must not happen.
 * Each list is read for a bounded number of pages; the post's own counters keep
 * the origin's totals.
 */

/** Pages of each list read per import (the AppView's maximum page is 100). */
const LIST_PAGES = 3;
const LIST_PAGE_SIZE = 100;
/** Quotes are whole posts to import; one page of them. */
const QUOTES_PAGE_SIZE = 50;

interface DidHolder {
  did?: unknown;
}

async function readDidList(
  nsid: 'app.bsky.feed.getLikes' | 'app.bsky.feed.getRepostedBy',
  uri: string,
): Promise<string[]> {
  const dids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const response = await xrpcGet<{
      likes?: Array<{ actor?: DidHolder }>;
      repostedBy?: DidHolder[];
      cursor?: string;
    }>(PUBLIC_APPVIEW, nsid, { uri, limit: LIST_PAGE_SIZE, cursor });
    const entries =
      nsid === 'app.bsky.feed.getLikes'
        ? (response?.likes ?? []).map((like) => like?.actor)
        : (response?.repostedBy ?? []);
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry?.did === 'string' && isDid(entry.did)) dids.add(entry.did);
    }
    cursor = typeof response?.cursor === 'string' && response.cursor ? response.cursor : undefined;
    if (!cursor) break;
  }
  return [...dids];
}

async function readQuotes(uri: string): Promise<AtprotoPostView[]> {
  const response = await xrpcGet<{ posts?: AtprotoPostView[] }>(
    PUBLIC_APPVIEW,
    'app.bsky.feed.getQuotes',
    { uri, limit: QUOTES_PAGE_SIZE },
  );
  return Array.isArray(response?.posts) ? response.posts : [];
}

/** Settle one list without letting its failure cost the other two. */
async function settle<T>(work: Promise<T>, fallback: T, list: string): Promise<T> {
  try {
    return await work;
  } catch (err) {
    logger.debug('[atproto] engagement list read failed', { list, error: String(err) });
    return fallback;
  }
}

/**
 * `did → oxyUserId` for the DIDs that are accounts here, stored under the DID or
 * under its Bridgy Fed actor URI (one person, either spelling).
 */
async function knownAccountsByDid(dids: readonly string[]): Promise<Map<string, string>> {
  const byUri = await findKnownOxyUserIdsByActorUris(
    dids.flatMap((did) => [did, bridgyActorUriForDid(did)]),
  );
  const known = new Map<string, string>();
  for (const did of dids) {
    const userId = byUri.get(did) ?? byUri.get(bridgyActorUriForDid(did));
    if (userId) known.set(did, userId);
  }
  return known;
}

/** A stable id for a repost seen on `getRepostedBy`, which does not name the record. */
export function repostSightingId(boosterDid: string, postUri: string): string {
  return `urn:mention:atproto-repost:${boosterDid}:${postUri}`;
}

/**
 * A repost first seen on `getRepostedBy` is stored under its sighting id, since
 * that list does not name the record. When the record itself arrives (the
 * firehose), the boost takes its real AT-URI, so an unrepost can find it.
 */
export async function adoptRepostSighting(
  boosterDid: string,
  postUri: string,
  repostUri: string,
): Promise<void> {
  await getDb()
    .update(posts)
    .set({ federationActivityId: repostUri })
    .where(
      and(
        eq(posts.federationActivityId, repostSightingId(boosterDid, postUri)),
        eq(posts.federationActorUri, boosterDid),
      ),
    );
}

/**
 * Import the known engagers of the local post `postId`, which mirrors the
 * Bluesky post `postUri`. Fail-soft per list; never throws on a remote failure.
 */
export async function importAtprotoEngagement(postId: string, postUri: string): Promise<void> {
  const [likerDids, boosterDids, quotes] = await Promise.all([
    settle(readDidList('app.bsky.feed.getLikes', postUri), [] as string[], 'likes'),
    settle(readDidList('app.bsky.feed.getRepostedBy', postUri), [] as string[], 'reposts'),
    settle(readQuotes(postUri), [] as AtprotoPostView[], 'quotes'),
  ]);
  const quoteAuthor = (view: AtprotoPostView) =>
    typeof view.author?.did === 'string' ? view.author.did : '';
  const known = await knownAccountsByDid([
    ...new Set([...likerDids, ...boosterDids, ...quotes.map(quoteAuthor)].filter(Boolean)),
  ]);
  if (known.size === 0) return;

  for (const did of likerDids) {
    const userId = known.get(did);
    if (userId) await materializeEngagementRelationship({ kind: 'like', userId, postId });
  }
  for (const did of boosterDids) {
    const boosterOxyUserId = known.get(did);
    if (!boosterOxyUserId) continue;
    await importAtprotoRepost({
      activityId: repostSightingId(did, postUri),
      originalPostId: postId,
      boosterOxyUserId,
      boosterDid: did,
    });
  }
  const knownQuotes = quotes.filter((view) => known.has(quoteAuthor(view)));
  if (knownQuotes.length > 0) await importPostViews(knownQuotes);
}
