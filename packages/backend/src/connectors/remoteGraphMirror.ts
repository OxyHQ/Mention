/**
 * The remote follow-graph mirror: reading who a remote account follows (and,
 * for a small account, who follows it) into `remote_follow_edges`, so a
 * federated profile's followers/following lists can show every account on them
 * that also exists here (`services/federation/remoteConnections.ts`).
 *
 * The mirror lives on the database every Oxy app shares, so it is bounded at
 * the root (production, read-only, 2026-11-04: 165 658 remote actors, 164 812 of
 * them linked to an Oxy account; their following p50 116, p90 715, p99 2 942):
 *
 * - **Who is crawled.** Only accounts that matter to people here: one a local
 *   user follows (the periodic sweep, {@link syncRemoteGraphMirror}), one whose
 *   profile or connections were opened, and one that just interacted with local
 *   content (an inbound follow, like, boost or mention). Never "every account
 *   known": all 165k at the cap would be ~82M edges.
 * - **How much per account.** {@link GRAPH_SIDE_CAP} accounts it follows, and its
 *   followers only when it has at most that many (a bigger followers collection
 *   is probed for visibility and never paged). 2 000 covers p99 of the accounts
 *   whose posts were synced in the last 30 days (p99 2 269) while halving the
 *   worst case of 5 000.
 * - **How long.** An edge whose other end is not an account here expires
 *   {@link UNKNOWN_EDGE_TTL_MS} after it was last seen — the window in which an
 *   account synced LATER still appears. An edge between two known accounts
 *   stays until a re-crawl stops seeing it.
 *
 * A collection the origin hides is not read, and what was stored from it is
 * dropped; an atproto graph is public by protocol. A Bridgy Fed actor URI is
 * stored as its DID, so one person is one node. Every crawl sits behind one
 * 24-hour cooldown + lease per account (`claimRemoteGraphCrawl`). Nothing here
 * writes to Oxy's follow graph.
 */

import type { FederatedActorRecord } from '../db/federation/actorRecord';
import { findActorByUri } from '../db/federation/actorRepository';
import {
  claimRemoteGraphCrawl,
  expireUnknownRemoteFollowEdges,
  findFollowedActorsDueForGraphCrawl,
  finishRemoteGraphCrawl,
  pruneRemoteFollowEdges,
  upsertRemoteFollowEdges,
  type RemoteFollowEdgeInput,
  type RemoteGraphCollectionState,
  type RemoteGraphCrawlSubject,
} from '../db/federation/remoteGraphRepository';
import { logger } from '../utils/logger';
import { readFollowCollection, type FollowCollectionRead } from './activitypub/followCollections';
import { FEDERATION_ENABLED } from './activitypub/constants';
import { ATPROTO_ENABLED } from './atproto/constants';
import { readAtprotoGraph, type AtprotoGraphRead } from './atproto/graphMirror';
import { didFromBridgyActorUri } from './shared/bridgyActor';

/**
 * At most this many accounts an account follows are mirrored, and its followers
 * are read only when it has at most this many.
 */
export const GRAPH_SIDE_CAP = 2_000;

/** An edge with an end not known here is kept this long after it was last seen. */
export const UNKNOWN_EDGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Edges deleted per expiry statement, and statements per sweep run. */
const EXPIRY_BATCH = 5_000;
const EXPIRY_BATCHES_PER_RUN = 20;

/** One crawl per account per day. */
const CRAWL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** A lease older than this belonged to a worker that died mid-crawl. */
const CRAWL_LEASE_TTL_MS = 30 * 60 * 1000;

/** ActivityPub page budget per collection (Mastodon serves 40-80 items a page). */
const AP_MAX_PAGES = 150;

/** View-triggered crawls running at once in one process; more are dropped, not queued. */
const MAX_DETACHED_CRAWLS = 2;

/** Followed accounts the sweep crawls per run, one after another. */
const FOLLOWED_BATCH_SIZE = 5;

/**
 * The ONE node an account is in the mirror: a Bridgy Fed actor URI
 * (`https://bsky.brid.gy/ap/<did>`) is the Bluesky account it bridges, so it is
 * stored as the DID; anything else is itself.
 */
export function graphNode(uri: string): string {
  return didFromBridgyActorUri(uri) ?? uri;
}

type SideRead =
  | { status: 'visible'; uris: string[]; complete: boolean }
  | { status: 'hidden' }
  | { status: 'failed' };

function fromAtproto(read: AtprotoGraphRead): SideRead {
  return read.status === 'visible'
    ? { status: 'visible', uris: read.dids, complete: read.complete }
    : read;
}

function fromActivityPub(read: FollowCollectionRead): SideRead {
  return read.status === 'visible'
    ? { status: 'visible', uris: read.uris, complete: read.complete }
    : read;
}

function protocolEnabled(protocol: RemoteGraphCrawlSubject['protocol']): boolean {
  if (protocol === 'atproto') return ATPROTO_ENABLED;
  if (protocol === 'activitypub') return FEDERATION_ENABLED;
  return false;
}

/** Read both sides of one account; a followers side that is too big is probed only. */
async function readSides(
  subject: RemoteGraphCrawlSubject,
): Promise<{ following: SideRead; followers: SideRead }> {
  const smallFollowers =
    typeof subject.followersCount === 'number' && subject.followersCount <= GRAPH_SIDE_CAP;
  if (subject.protocol === 'atproto') {
    const following = fromAtproto(await readAtprotoGraph(subject.uri, 'follows', GRAPH_SIDE_CAP));
    const followers: SideRead = smallFollowers
      ? fromAtproto(await readAtprotoGraph(subject.uri, 'followers', GRAPH_SIDE_CAP))
      : { status: 'visible', uris: [], complete: false };
    return { following, followers };
  }
  const following = fromActivityPub(
    await readFollowCollection(subject.followingUrl, {
      maxItems: GRAPH_SIDE_CAP,
      maxPages: AP_MAX_PAGES,
    }),
  );
  const followers = fromActivityPub(
    await readFollowCollection(subject.followersUrl, {
      maxItems: smallFollowers ? GRAPH_SIDE_CAP : 0,
      maxPages: smallFollowers ? AP_MAX_PAGES : 0,
    }),
  );
  return { following, followers };
}

/** Store or drop one side's edges; returns the side's state, undefined when unread. */
async function applySide(
  subject: RemoteGraphCrawlSubject,
  side: 'following' | 'followers',
  read: SideRead,
  crawlStartedAt: Date,
): Promise<RemoteGraphCollectionState | undefined> {
  const node = graphNode(subject.uri);
  const own = side === 'following' ? { sourceUri: node } : { targetUri: node };
  if (read.status === 'failed') return undefined;
  if (read.status === 'hidden') {
    // The account withholds this side: nothing stored about it stays.
    await pruneRemoteFollowEdges(own, new Date());
    return 'hidden';
  }
  const self = graphNode(subject.uri);
  const edges: RemoteFollowEdgeInput[] = read.uris.map((uri) =>
    side === 'following'
      ? { sourceUri: self, targetUri: graphNode(uri) }
      : { sourceUri: graphNode(uri), targetUri: self },
  );
  await upsertRemoteFollowEdges(edges, new Date());
  if (read.complete) await pruneRemoteFollowEdges(own, crawlStartedAt);
  return 'visible';
}

/**
 * Crawl one account's graph if its cooldown has passed and nobody else is.
 * Never throws: a crawl is a background side effect.
 */
export async function crawlRemoteGraph(subject: RemoteGraphCrawlSubject): Promise<void> {
  if (!protocolEnabled(subject.protocol)) return;
  const now = new Date();
  let claimed = false;
  try {
    claimed = await claimRemoteGraphCrawl(
      subject.uri,
      now,
      new Date(now.getTime() - CRAWL_COOLDOWN_MS),
      new Date(now.getTime() - CRAWL_LEASE_TTL_MS),
    );
  } catch (err) {
    logger.error('[RemoteGraph] failed to claim a crawl', { error: String(err) });
    return;
  }
  if (!claimed) return;

  try {
    const { following, followers } = await readSides(subject);
    const followingState = await applySide(subject, 'following', following, now);
    const followersState = await applySide(subject, 'followers', followers, now);
    await finishRemoteGraphCrawl(subject.uri, now, {
      completed: following.status !== 'failed' && followers.status !== 'failed',
      followingState,
      followersState,
    });
  } catch (err) {
    logger.warn('[RemoteGraph] crawl failed', { error: String(err) });
    await finishRemoteGraphCrawl(subject.uri, now, { completed: false }).catch(() => undefined);
  }
}

let detachedCrawls = 0;

/**
 * Start a crawl off the request path (connections opened, profile viewed). A
 * process already running {@link MAX_DETACHED_CRAWLS} drops this one; the
 * account is crawled by the next trigger instead.
 */
export function crawlRemoteGraphInBackground(
  actor: Pick<
    FederatedActorRecord,
    'uri' | 'protocol' | 'followingUrl' | 'followersUrl' | 'followersCount' | 'oxyUserId'
  >,
): void {
  if (!actor.oxyUserId || detachedCrawls >= MAX_DETACHED_CRAWLS) return;
  detachedCrawls += 1;
  void crawlRemoteGraph({
    uri: actor.uri,
    protocol: actor.protocol,
    followingUrl: actor.followingUrl,
    followersUrl: actor.followersUrl,
    followersCount: actor.followersCount ?? undefined,
  }).finally(() => {
    detachedCrawls -= 1;
  });
}

/**
 * Crawl the account behind an actor URI that just interacted with local content
 * (an inbound follow, like, boost or mention), off the inbox's path. Never
 * throws; an actor not stored or not linked to an Oxy user is skipped.
 */
export function crawlRemoteGraphForInteraction(actorUri: string): void {
  if (detachedCrawls >= MAX_DETACHED_CRAWLS) return;
  void findActorByUri(actorUri)
    .then((actor) => {
      if (actor) crawlRemoteGraphInBackground(actor);
    })
    .catch((err) =>
      logger.debug('[RemoteGraph] interaction lookup failed', { error: String(err) }),
    );
}

/**
 * The periodic sweep: crawl the followed accounts that are due, then expire
 * edges whose other end never became an account here. Both are bounded per run.
 */
export async function syncRemoteGraphMirror(now = new Date()): Promise<{
  crawled: number;
  expired: number;
}> {
  const protocols = (['activitypub', 'atproto'] as const).filter(protocolEnabled);
  const subjects = await findFollowedActorsDueForGraphCrawl(
    protocols,
    new Date(now.getTime() - CRAWL_COOLDOWN_MS),
    FOLLOWED_BATCH_SIZE,
  );
  for (const subject of subjects) await crawlRemoteGraph(subject);

  const cutoff = new Date(now.getTime() - UNKNOWN_EDGE_TTL_MS);
  let expired = 0;
  for (let batch = 0; batch < EXPIRY_BATCHES_PER_RUN; batch += 1) {
    const deleted = await expireUnknownRemoteFollowEdges(cutoff, EXPIRY_BATCH);
    expired += deleted;
    if (deleted < EXPIRY_BATCH) break;
  }
  return { crawled: subjects.length, expired };
}
