/**
 * Likes, reposts and follows from Jetstream, kept current between accounts
 * Mention already holds — the live half of the remote graph mirror and the
 * Bluesky engagement import (`connectors/remoteGraphMirror.ts`,
 * `connectors/atproto/engagementImport.ts`), through their write paths.
 *
 * These collections are most of Bluesky's traffic (likes alone are several
 * hundred a second), and almost none of it concerns us. So every commit is
 * first matched IN MEMORY against the Bluesky accounts known here
 * ({@link createKnownBlueskyAccounts}); only a commit by a known account reaches
 * the database. Nothing is minted for a stranger, and nothing widens what the
 * mirror covers:
 *
 *  - **like**: a known account's like of a stored post is materialized with the
 *    like record's AT-URI as its id (`materializeEngagementRelationship`); its
 *    unlike tombstones that id.
 *  - **repost**: a known account's repost of a stored post becomes a boost under
 *    the repost's AT-URI (`importAtprotoRepost`, adopting a `getRepostedBy`
 *    sighting first); its unrepost deletes that boost
 *    (`deleteStoredAtprotoRecords`).
 *  - **follow**: an edge is added only when its source is an account whose
 *    following the mirror crawls and its target is an account known here, so
 *    the live edges are a subset of what a crawl could store and never expire
 *    unbounded; an unfollow deletes the edge by its record key.
 */

import { findKnownBlueskyAccounts } from '../../../db/federation/actorRepository';
import {
  deleteRemoteFollowEdgesByRecordKeys,
  findCrawledFollowingSources,
  upsertRemoteFollowEdges,
} from '../../../db/federation/remoteGraphRepository';
import {
  materializeEngagementRelationship,
  materializeEngagementTombstone,
} from '../../../services/PostEngagementCommandService';
import {
  BRIDGY_FED_BSKY_HOST,
  bridgyActorUriForDid,
  didFromBridgyActorUri,
} from '../../shared/bridgyActor';
import { findPostsByFederatedObjects } from '../../shared/upstreamPostKey';
import { isDid } from '../constants';
import { adoptRepostSighting } from '../engagementImport';
import { importAtprotoRepost } from '../post.mapper';
import type { JetstreamCollectionHandler } from './JetstreamConsumer';
import { deleteStoredAtprotoRecords } from './postHandler';
import type { JetstreamCommit } from './protocol';

export const LIKE_COLLECTION = 'app.bsky.feed.like';
export const REPOST_COLLECTION = 'app.bsky.feed.repost';
export const FOLLOW_COLLECTION = 'app.bsky.graph.follow';

/** How long the known-account set is reused before it is read again. */
const KNOWN_ACCOUNTS_TTL_MS = 5 * 60_000;

/** `did → oxyUserId` for every Bluesky account known here. */
export type KnownBlueskyAccounts = () => Promise<ReadonlyMap<string, string>>;

/**
 * The Bluesky accounts known here, by DID, re-read every few minutes. An account
 * stored through Bridgy Fed is keyed by the DID its actor URI carries, so one
 * person is one entry whichever way they reached us.
 */
export function createKnownBlueskyAccounts(
  load: () => Promise<Array<{ uri: string; oxyUserId: string }>> = () =>
    findKnownBlueskyAccounts(BRIDGY_FED_BSKY_HOST),
): KnownBlueskyAccounts {
  let accounts: ReadonlyMap<string, string> = new Map();
  let loadedAt = 0;
  return async () => {
    if (Date.now() - loadedAt >= KNOWN_ACCOUNTS_TTL_MS) {
      const byDid = new Map<string, string>();
      for (const row of await load()) {
        const did = isDid(row.uri) ? row.uri : didFromBridgyActorUri(row.uri);
        if (did && !byDid.has(did)) byDid.set(did, row.oxyUserId);
      }
      accounts = byDid;
      loadedAt = Date.now();
    }
    return accounts;
  };
}

/** The AT-URI a like or repost record points at (`subject` is a strong ref). */
function subjectUri(record: unknown): string | undefined {
  const subject = (record as { subject?: { uri?: unknown } } | undefined)?.subject;
  return typeof subject?.uri === 'string' ? subject.uri : undefined;
}

/** The DID a follow record points at (`subject` is the DID itself). */
function subjectDid(record: unknown): string | undefined {
  const subject = (record as { subject?: unknown } | undefined)?.subject;
  return typeof subject === 'string' && isDid(subject) ? subject : undefined;
}

/**
 * `AT-URI → local post id` for the stored posts among `uris`, by activity id or
 * upstream key, so a post Bridgy Fed delivered first is found under its AT-URI.
 */
async function storedPostIds(uris: readonly string[]): Promise<Map<string, string>> {
  const stored = await findPostsByFederatedObjects(uris);
  return new Map([...stored].map(([uri, post]) => [uri, post.id]));
}

/** The commits by known accounts, with each one's Oxy user. */
async function byKnownAccounts(
  commits: readonly JetstreamCommit[],
  known: KnownBlueskyAccounts,
): Promise<Array<{ commit: JetstreamCommit; userId: string }>> {
  const accounts = await known();
  return commits.flatMap((commit) => {
    const userId = accounts.get(commit.did);
    return userId ? [{ commit, userId }] : [];
  });
}

export function createLikeJetstreamHandler(
  known: KnownBlueskyAccounts,
): JetstreamCollectionHandler {
  return {
    collection: LIKE_COLLECTION,
    async handle(commits) {
      const mine = await byKnownAccounts(commits, known);
      if (mine.length === 0) return;
      const postIds = await storedPostIds(
        mine.flatMap(({ commit }) => {
          const uri = commit.operation === 'create' ? subjectUri(commit.record) : undefined;
          return uri ? [uri] : [];
        }),
      );
      for (const { commit, userId } of mine) {
        if (commit.operation === 'delete') {
          await materializeEngagementTombstone({
            kind: 'like',
            relationshipId: commit.uri,
            userId,
          });
          continue;
        }
        const postId =
          commit.operation === 'create' ? postIds.get(subjectUri(commit.record) ?? '') : undefined;
        if (postId) {
          await materializeEngagementRelationship({
            kind: 'like',
            relationshipId: commit.uri,
            userId,
            postId,
          });
        }
      }
    },
  };
}

export function createRepostJetstreamHandler(
  known: KnownBlueskyAccounts,
): JetstreamCollectionHandler {
  return {
    collection: REPOST_COLLECTION,
    async handle(commits) {
      const mine = await byKnownAccounts(commits, known);
      if (mine.length === 0) return;
      const creates = mine.filter(({ commit }) => commit.operation === 'create');
      const postIds = await storedPostIds(
        creates.flatMap(({ commit }) => subjectUri(commit.record) ?? []),
      );
      for (const { commit, userId } of creates) {
        const postUri = subjectUri(commit.record);
        const originalPostId = postUri ? postIds.get(postUri) : undefined;
        if (!postUri || !originalPostId) continue;
        await adoptRepostSighting(commit.did, postUri, commit.uri);
        await importAtprotoRepost({
          activityId: commit.uri,
          originalPostId,
          boosterOxyUserId: userId,
          boosterDid: commit.did,
        });
      }
      await deleteStoredAtprotoRecords(
        mine.filter(({ commit }) => commit.operation === 'delete').map(({ commit }) => commit),
      );
    },
  };
}

export function createFollowJetstreamHandler(
  known: KnownBlueskyAccounts,
): JetstreamCollectionHandler {
  return {
    collection: FOLLOW_COLLECTION,
    async handle(commits) {
      const mine = await byKnownAccounts(commits, known);
      if (mine.length === 0) return;
      const accounts = await known();

      const follows = mine.flatMap(({ commit }) => {
        const target = commit.operation === 'create' ? subjectDid(commit.record) : undefined;
        return target && accounts.has(target) ? [{ commit, target }] : [];
      });
      if (follows.length > 0) {
        // The crawl row is keyed by the actor's URI: the DID, or its Bridgy one.
        const crawled = await findCrawledFollowingSources(
          follows.flatMap(({ commit }) => [commit.did, bridgyActorUriForDid(commit.did)]),
        );
        const edges = follows
          .filter(
            ({ commit }) =>
              crawled.has(commit.did) || crawled.has(bridgyActorUriForDid(commit.did)),
          )
          .map(({ commit, target }) => ({
            sourceUri: commit.did,
            targetUri: target,
            recordKey: commit.rkey,
          }));
        await upsertRemoteFollowEdges(edges, new Date());
      }

      await deleteRemoteFollowEdgesByRecordKeys(
        mine
          .filter(({ commit }) => commit.operation === 'delete')
          .map(({ commit }) => ({ sourceUri: commit.did, recordKey: commit.rkey })),
      );
    },
  };
}
