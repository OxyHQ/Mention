import type { IFederatedActor } from '../../models/FederatedActor';
import type {
  NetworkConnector,
  NetworkId,
  NormalizedExternalActor,
  LocalNetworkEvent,
  ReceiveContext,
  FetchPostsOptions,
  FetchPostsResult,
} from '../types';
import { resolveOxyExternalUser } from '../identity';
import { isAbsoluteHttpUrl } from '../shared/url';
import { actorService } from './actor.service';
import { followService, type NoteSourcePost, type NoteReplyContext } from './follow.service';
import { outboxSyncService } from './outbox.service';
import { inboxProcessingService } from './inbox.service';
import { FEDERATION_ENABLED, isBlockedDomain } from './constants';
import { normalizeFederatedAcct, domainFromAcct } from './helpers';
import {
  isPermanentlyUnavailableOutboxReason,
  PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS,
  type OutboxSyncResult,
  type OutboxSyncOptions,
  type OutboxSyncFailureReason,
} from './outbox.service';

// Re-export the outbox failure-reason contract from its owning sub-service so a
// single import site (`activityPubConnector` + these helpers) serves every
// caller that used to read them from the deleted FederationService facade.
export {
  isPermanentlyUnavailableOutboxReason,
  PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS,
  type OutboxSyncResult,
  type OutboxSyncOptions,
  type OutboxSyncFailureReason,
};

/**
 * The ActivityPub (Mastodon/fediverse) network connector.
 *
 * Two responsibilities:
 *
 *  (a) It ABSORBS the public API of the former `FederationService` facade —
 *      every method other modules call (actor resolution, outbox backfill,
 *      outbound delivery, follow lifecycle, inbox processing) — by delegating to
 *      the four sub-service singletons. Call sites that historically used
 *      `federationService.*` now use `activityPubConnector.*`, 1:1.
 *
 *  (b) It implements the network-neutral {@link NetworkConnector} contract so the
 *      connector registry can fan out outbound events to it and (later) resolve
 *      handles across networks uniformly.
 *
 * The private key never leaves Oxy; protocol specifics live in the sub-services.
 */
class ActivityPubConnector implements NetworkConnector {
  readonly id: NetworkId = 'activitypub';

  get enabled(): boolean {
    return FEDERATION_ENABLED;
  }

  // ============================================================
  // NetworkConnector contract
  // ============================================================

  /**
   * True for a fediverse handle (`@user@host` / `user@host`) on a non-local
   * domain, or an absolute actor URI on a non-local host.
   */
  matches(subject: string): boolean {
    const normalized = normalizeFederatedAcct(subject);
    if (normalized) {
      const domain = domainFromAcct(normalized);
      return Boolean(domain && !isBlockedDomain(domain));
    }
    if (isAbsoluteHttpUrl(subject)) {
      try {
        return !isBlockedDomain(new URL(subject).hostname.toLowerCase());
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Resolve a fediverse handle to a normalized actor (WebFinger → actor fetch). */
  async resolve(handle: string): Promise<NormalizedExternalActor | null> {
    const actorUri = await actorService.resolveWebFinger(handle);
    if (!actorUri) return null;
    return this.fetchProfile(actorUri);
  }

  /** Fetch + normalize a remote actor profile by its actor URI. */
  async fetchProfile(externalId: string): Promise<NormalizedExternalActor | null> {
    const actor = await actorService.fetchRemoteActor(externalId);
    return actor ? this.normalizeActor(actor) : null;
  }

  /**
   * Backfill a remote actor's outbox. ActivityPub outbox sync is a side-effecting
   * DB backfill (it inserts/dedupes posts into Mongo, read back via the
   * `/federation/actor/posts` route), so this advances the opaque outbox cursor
   * and returns it; the imported posts are not echoed back in-band.
   */
  async fetchPosts(externalId: string, opts: FetchPostsOptions = {}): Promise<FetchPostsResult> {
    const actor = await actorService.getOrFetchActor(externalId);
    if (!actor?.outboxUrl) return { posts: [] };
    // Forward the incoming opaque cursor as `startPageUrl` so pagination advances:
    // `fetchPosts` returns `result.nextCursor?.url`, and `syncOutboxPostsDetailed`
    // resumes at `startPageUrl` (validated same-origin against the outbox). Absent
    // cursor → first page.
    const result = await outboxSyncService.syncOutboxPostsDetailed(actor, {
      limit: opts.limit ?? 20,
      startPageUrl: opts.cursor,
    });
    return { posts: [], cursor: result.nextCursor?.url };
  }

  /** Deliver a local domain event outbound to the fediverse. */
  async deliver(event: LocalNetworkEvent): Promise<void> {
    switch (event.kind) {
      case 'post.create':
        await followService.federateNewPost(event.post, event.actorOxyUserId, event.actorUsername);
        break;
      case 'post.boost':
        // A boost federates as an Announce of the original's canonical AP id,
        // delivered to the booster's followers + (federated original) its author.
        await followService.federateBoost(event.boost, event.actorOxyUserId, event.actorUsername);
        break;
      case 'post.unboost':
        await followService.federateUndoBoost(event.boost, event.actorOxyUserId, event.actorUsername);
        break;
      case 'post.update':
        // An edit re-federates the Note as an Update (with an `updated` stamp),
        // preserving the reply enrichment via the shared Note builder.
        await followService.federateUpdate(event.post, event.actorOxyUserId, event.actorUsername);
        break;
      case 'post.delete':
        // A deletion broadcasts a Delete(Tombstone) of the post's canonical AP id
        // to the deleter's followers.
        await followService.federateDelete(event.post, event.actorOxyUserId, event.actorUsername);
        break;
      case 'post.like':
        // A like of a FEDERATED post sends a Like to the origin author's inbox
        // only (never fanned out to the liker's followers). Local-post likes no-op.
        await followService.federateLike(event.like, event.actorOxyUserId, event.actorUsername);
        break;
      case 'post.unlike':
        await followService.federateUndoLike(event.like, event.actorOxyUserId, event.actorUsername);
        break;
      case 'actor.update':
        // A Mention-owned profile change (e.g. the banner) rebroadcasts the full
        // actor document as an Update(Person) to remote followers.
        await followService.federateActorUpdate(event.actorOxyUserId, event.actorUsername);
        break;
      case 'follow.add':
        // Sends a Follow activity + records the outbound FederatedFollow. The
        // `{ success, pending }` it returns is surfaced by the route via the
        // actor's `manuallyApprovesFollowers` flag (route reads it post-deliver).
        await followService.sendFollow(event.localOxyUserId, event.localUsername, event.targetActorUri);
        break;
      case 'follow.remove':
        await followService.sendUndoFollow(event.localOxyUserId, event.localUsername, event.targetActorUri);
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`ActivityPubConnector: unhandled local event ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Process an inbound, already-verified ActivityPub activity. */
  async receive(payload: unknown, ctx: ReceiveContext): Promise<void> {
    await inboxProcessingService.processInboxActivity(
      payload as Record<string, any>,
      ctx.verifiedActorUri,
    );
  }

  /** Resolve/mint the Oxy user a normalized actor maps to. */
  mapIdentity(actor: NormalizedExternalActor): Promise<string | null> {
    return resolveOxyExternalUser(actor);
  }

  /** Map a stored {@link IFederatedActor} to the network-neutral shape. */
  private normalizeActor(actor: IFederatedActor): NormalizedExternalActor {
    return {
      network: 'activitypub',
      externalId: actor.uri,
      handle: actor.acct,
      // For AP the acct IS the canonical `user@domain` Oxy username, and the
      // stored `domain` is its instance host.
      federatedUsername: actor.acct,
      instanceDomain: actor.domain,
      // Display names are owned by the Oxy API (`name.displayName`); a federated
      // actor row carries no local name copy.
      avatarUrl: actor.avatarUrl,
      bannerUrl: actor.headerUrl,
      bio: actor.summary,
      followersCount: actor.followersCount,
      followingCount: actor.followingCount,
      postsCount: actor.postsCount,
      oxyUserId: actor.oxyUserId ?? undefined,
    };
  }

  // ============================================================
  // Absorbed FederationService facade — actor resolution
  // (delegated to ActorService)
  // ============================================================

  resolveWebFinger(acct: string): Promise<string | null> {
    return actorService.resolveWebFinger(acct);
  }

  fetchRemoteActor(actorUri: string, forceAvatarRefresh = false, acctHint?: string): Promise<IFederatedActor | null> {
    return actorService.fetchRemoteActor(actorUri, forceAvatarRefresh, acctHint);
  }

  getOrFetchActor(actorUri: string): Promise<IFederatedActor | null> {
    return actorService.getOrFetchActor(actorUri);
  }

  refreshActorInBackground(actorUri: string, existing?: IFederatedActor): void {
    actorService.refreshActorInBackground(actorUri, existing);
  }

  fetchPublicKey(keyId: string): Promise<{ publicKeyPem: string; actorUri: string } | null> {
    return actorService.fetchPublicKey(keyId);
  }

  // ============================================================
  // Absorbed FederationService facade — outbox backfill
  // (delegated to OutboxSyncService)
  // ============================================================

  syncOutboxPosts(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string; type?: string },
    limit = 20,
  ): Promise<number> {
    return outboxSyncService.syncOutboxPosts(actor, limit);
  }

  syncOutboxPostsDetailed(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string; type?: string },
    limitOrOptions: number | OutboxSyncOptions = 20,
  ): Promise<OutboxSyncResult> {
    return outboxSyncService.syncOutboxPostsDetailed(actor, limitOrOptions);
  }

  markOutboxBackfillUnavailable(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct'> & { _id: unknown },
    reason?: string,
  ): Promise<void> {
    return outboxSyncService.markOutboxBackfillUnavailable(actor, reason);
  }

  // ============================================================
  // Absorbed FederationService facade — delivery + follow lifecycle
  // (delegated to FollowService)
  // ============================================================

  deliverActivity(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<boolean> {
    return followService.deliverActivity(activity, targetInbox, senderOxyUserId, senderUsername);
  }

  queueDelivery(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
  ): Promise<void> {
    return followService.queueDelivery(activity, targetInbox, senderOxyUserId);
  }

  deliverToFollowers(
    activity: Record<string, unknown>,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    return followService.deliverToFollowers(activity, senderOxyUserId, senderUsername);
  }

  buildCreateNoteActivity(
    post: NoteSourcePost,
    username: string,
    reply?: NoteReplyContext,
  ): Record<string, unknown> {
    return followService.buildCreateNoteActivity(post, username, reply);
  }

  /**
   * Resolve a post's reply addressing (`inReplyTo` + parent-author `Mention`) for
   * a PULL surface (the per-post dereference route). Null when the post is not a
   * reply or the parent is unresolvable (fail-soft). The push path resolves this
   * internally in {@link FollowService.federateNewPost}, unioning the parent
   * author's inbox into delivery.
   */
  resolveReplyContext(post: NoteSourcePost): Promise<NoteReplyContext | null> {
    return followService.resolveReplyContext(post);
  }

  federateNewPost(
    post: NoteSourcePost & { visibility: string },
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    return followService.federateNewPost(post, senderOxyUserId, senderUsername);
  }

  sendFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<{ success: boolean; pending: boolean }> {
    return followService.sendFollow(localOxyUserId, localUsername, remoteActorUri);
  }

  sendUndoFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<boolean> {
    return followService.sendUndoFollow(localOxyUserId, localUsername, remoteActorUri);
  }

  sendAccept(
    localOxyUserId: string,
    localUsername: string,
    followActivityId: string,
    remoteActorUri: string,
  ): Promise<void> {
    return followService.sendAccept(localOxyUserId, localUsername, followActivityId, remoteActorUri);
  }

  // ============================================================
  // Absorbed FederationService facade — inbox processing
  // (delegated to InboxProcessingService)
  // ============================================================

  processInboxActivity(
    activity: Record<string, any>,
    verifiedActorUri: string,
  ): Promise<void> {
    return inboxProcessingService.processInboxActivity(activity, verifiedActorUri);
  }
}

export const activityPubConnector = new ActivityPubConnector();
export default activityPubConnector;
