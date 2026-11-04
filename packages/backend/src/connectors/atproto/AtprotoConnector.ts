import type { PostContent } from '@mention/shared-types';
import type {
  FetchPostsOptions,
  FetchPostsResult,
  LocalNetworkEvent,
  NetworkConnector,
  NetworkId,
  NormalizedExternalActor,
} from '@oxy.so/federation';
import { logger } from '../../utils/logger';
import {
  deleteFollow,
  upsertOutboundAcceptedSubscription,
} from '../../db/federation/followRepository';
import { ATPROTO_ENABLED, isAtUri, isAtprotoHandle, isDid } from './constants';
import { fetchAndUpsertAtprotoProfile } from './profile.mapper';
import { startJetstreamIngestion, stopJetstreamIngestion } from './jetstream';
import { importAuthorFeed } from './post.mapper';
import {
  advanceAtprotoHistoryBackfills,
  importAccountPosts,
  syncFollowedAtprotoAccounts,
} from './accountSync';

/**
 * The AT Protocol (Bluesky) network connector — it READS Bluesky.
 *
 * It mirrors profiles Oxy verified into `FederatedActor` (`protocol:'atproto'`)
 * under the Oxy user Oxy resolved, and backfills an
 * actor's author feed through the SAME `getPostCreator().create` path
 * ActivityPub uses: their posts as native `Post` rows (deduped on the AT-URI,
 * with the posts they reply to and quote), their pinned post, and their reposts
 * as boosts, the way an ActivityPub `Announce` is stored.
 *
 * Outbound is intentionally minimal: `deliver({kind:'follow.add'})` records a
 * LOCAL subscription (no Follow is written to the atproto network) and triggers a
 * post backfill; `post.create` is a no-op. The read-only bridge routes make a
 * local user discoverable/readable FROM atproto (via did:web); Mention does not
 * publish posts into a foreign PDS. The connector never uses `@atproto/api`;
 * every network read goes through the SSRF-safe XRPC client.
 */
class AtprotoConnector implements NetworkConnector<PostContent> {
  readonly id: NetworkId = 'atproto';

  get enabled(): boolean {
    return ATPROTO_ENABLED;
  }

  /** True for an atproto DID, an AT-URI, or a bare handle (DNS name, no `@`). */
  matches(subject: string): boolean {
    const value = subject.trim();
    return isDid(value) || isAtUri(value) || isAtprotoHandle(value);
  }

  /** Fetch + normalize an atproto profile by its DID (or handle). */
  fetchProfile(externalId: string): Promise<NormalizedExternalActor | null> {
    return fetchAndUpsertAtprotoProfile(externalId);
  }

  /**
   * Backfill an actor's recent posts. Resolves/refreshes the actor (so its Oxy
   * user is known — no orphan posts), then imports `app.bsky.feed.getAuthorFeed`.
   */
  fetchPosts(externalId: string, opts: FetchPostsOptions = {}): Promise<FetchPostsResult> {
    return importAccountPosts(externalId, opts);
  }

  /** The periodic job body: the newest page of each followed account that is due. */
  syncFollowedAccounts(): Promise<number> {
    return syncFollowedAtprotoAccounts();
  }

  /** The periodic job body: advance the bounded post-history backfills. */
  advanceHistoryBackfills(): Promise<number> {
    return advanceAtprotoHistoryBackfills();
  }

  /** Open the live Jetstream subscription (scheduler leader only). */
  startLiveIngestion(): void {
    startJetstreamIngestion();
  }

  /** Close it, saving how far it got. */
  stopLiveIngestion(): Promise<void> {
    return stopJetstreamIngestion();
  }

  /** Deliver a local domain event. */
  async deliver(event: LocalNetworkEvent<PostContent>): Promise<void> {
    switch (event.kind) {
      case 'post.create':
      case 'post.boost':
      case 'post.unboost':
      case 'post.update':
      case 'post.delete':
      case 'post.like':
      case 'post.unlike':
      case 'actor.update':
        // Mention does not publish posts, reposts, edits, deletes, likes, or
        // actor changes into a foreign atproto PDS. Its local repository is
        // exposed read-only through the bridge routes. No-op.
        return;
      case 'follow.add':
        await this.followActor(event.localOxyUserId, event.targetActorUri);
        return;
      case 'follow.remove':
        await this.unfollowActor(event.localOxyUserId, event.targetActorUri);
        return;
      default: {
        const exhaustive: never = event;
        throw new Error(`AtprotoConnector: unhandled local event ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Record a LOCAL subscription to an atproto actor and backfill its posts. No
   * Follow record is written to the atproto network (Mention publishes nothing
   * into a foreign PDS); the subscription merges the actor's posts into the
   * viewer's feed exactly like the ActivityPub `/federation/following` path.
   */
  private async followActor(localOxyUserId: string, targetDid: string): Promise<void> {
    // Resolve the actor first so `targetDid` is canonical (a handle/AT-URI is
    // normalized to its DID) and its Oxy user is minted before the backfill.
    const actor = await this.fetchProfile(this.toIdentityInput(targetDid.trim()));
    const canonicalDid = actor?.externalId ?? targetDid;

    await upsertOutboundAcceptedSubscription(localOxyUserId, canonicalDid, 'atproto');

    // Backfill the followed actor's recent posts in the background.
    if (actor?.oxyUserId) {
      void importAuthorFeed(actor, { limit: 20 }).catch((err) => {
        logger.warn('[atproto] follow backfill failed', err);
      });
    }
  }

  /** Remove the local subscription to an atproto actor. */
  private async unfollowActor(localOxyUserId: string, targetDid: string): Promise<void> {
    // Resolve the input to its canonical DID EXACTLY as `followActor` does, so the
    // delete keys on the same id the follow was stored under. A handle/AT-URI is
    // normalized to its DID; if resolution fails both paths fall back to the raw
    // input (so a degraded follow stored under a handle still unfollows). Without
    // this, an unfollow-by-handle would never match the DID-keyed follow record
    // and the subscription would stay stuck.
    const actor = await this.fetchProfile(this.toIdentityInput(targetDid.trim()));
    const canonicalDid = actor?.externalId ?? targetDid;

    await deleteFollow(localOxyUserId, canonicalDid, 'outbound');
  }

  /** Strip an `at://<authority>/...` to its authority (a handle or DID) for Oxy to resolve. */
  private toIdentityInput(subject: string): string {
    if (isAtUri(subject)) {
      const authority = subject.slice('at://'.length).split('/')[0];
      return authority || subject;
    }
    return subject;
  }
}

export const atprotoConnector = new AtprotoConnector();
export default atprotoConnector;
