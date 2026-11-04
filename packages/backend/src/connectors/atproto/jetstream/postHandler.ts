/**
 * `app.bsky.feed.post` from Jetstream: new posts of the accounts Mention
 * follows, and deletes of any Bluesky post Mention stores.
 *
 *  - **Creates** are imported only for followed accounts, by AT-URI, through
 *    `importPostsByUri` — AppView hydration plus the one post mapper, the same
 *    import an author-feed read uses. An account nobody follows is still read
 *    when someone opens it (profile-view sync); a create costs an AppView call
 *    and media mirroring, so it is not spent on every account that ever posted.
 *  - **Deletes** apply to every stored post, whoever wrote it: a reply-context
 *    post, a quoted one, a viewed profile's. A delete costs one indexed lookup,
 *    and it is the only way Mention learns that a Bluesky post is gone.
 *  - **Updates** are ignored: Bluesky has no post editing, and an author-feed
 *    import is keyed on the AT-URI, so a re-written record would not re-import.
 */

import { inArray } from 'drizzle-orm';
import { distinctRemoteActorUris } from '../../../db/federation/followRepository';
import { getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { deleteFederatedPostSubtree } from '../../../services/FederatedPostDeletionService';
import { logger } from '../../../utils/logger';
import { POST_COLLECTION } from '../constants';
import { importPostsByUri } from '../post.mapper';
import type { JetstreamCollectionHandler } from './JetstreamConsumer';
import type { JetstreamCommit } from './protocol';

/** How long the followed-account set is reused before it is read again. */
const FOLLOWED_DIDS_TTL_MS = 60_000;

/** The DIDs of every Bluesky account a local account follows. */
function followedAtprotoDids(): Promise<string[]> {
  return distinctRemoteActorUris({
    direction: 'outbound',
    statuses: ['accepted'],
    network: 'atproto',
  });
}

/**
 * Delete the stored posts these record deletes name, through the same cascade
 * an ActivityPub `Delete` runs (`deleteFederatedPostSubtree`). A post is only
 * deleted when it was stored under the deleting repository's DID, which the
 * AT-URI's authority already guarantees — the check keeps it explicit.
 *
 * Collection-agnostic: a repost (stored as a boost under its own AT-URI) is
 * deleted the same way, so a repost handler can call it as it is.
 *
 * @returns how many posts were deleted.
 */
export async function deleteStoredAtprotoRecords(
  commits: readonly JetstreamCommit[],
): Promise<number> {
  const didByUri = new Map(commits.map((commit) => [commit.uri, commit.did]));
  if (didByUri.size === 0) return 0;
  const stored = await getDb()
    .select({ id: posts.id, uri: posts.federationActivityId, actorUri: posts.federationActorUri })
    .from(posts)
    .where(inArray(posts.federationActivityId, [...didByUri.keys()]));

  let deleted = 0;
  for (const post of stored) {
    const did = post.uri ? didByUri.get(post.uri) : undefined;
    if (!did || post.actorUri !== did) continue;
    if ((await deleteFederatedPostSubtree(post.id, did)) === 'deleted') deleted += 1;
  }
  return deleted;
}

export interface PostHandlerOptions {
  /** Where the followed accounts come from (the follow table by default). */
  followedDids?: () => Promise<readonly string[]>;
}

/** The `app.bsky.feed.post` handler. */
export function createPostJetstreamHandler(
  options: PostHandlerOptions = {},
): JetstreamCollectionHandler {
  const loadFollowed = options.followedDids ?? followedAtprotoDids;
  let followed: ReadonlySet<string> = new Set();
  let followedAt = 0;

  async function followedSet(): Promise<ReadonlySet<string>> {
    if (Date.now() - followedAt >= FOLLOWED_DIDS_TTL_MS) {
      followed = new Set(await loadFollowed());
      followedAt = Date.now();
    }
    return followed;
  }

  return {
    collection: POST_COLLECTION,
    async handle(commits) {
      const deletes = commits.filter((commit) => commit.operation === 'delete');
      const creates = commits.filter((commit) => commit.operation === 'create');

      if (creates.length > 0) {
        const tracked = await followedSet();
        const wanted = creates.filter((commit) => tracked.has(commit.did));
        if (wanted.length > 0) {
          const created = await importPostsByUri(wanted.map((commit) => commit.uri));
          logger.debug('[jetstream] imported posts', { seen: wanted.length, created });
        }
      }
      // After the creates: a post made and deleted inside one batch ends deleted.
      if (deletes.length > 0) {
        const deleted = await deleteStoredAtprotoRecords(deletes);
        if (deleted > 0) logger.info('[jetstream] deleted posts', { count: deleted });
      }
    },
  };
}
