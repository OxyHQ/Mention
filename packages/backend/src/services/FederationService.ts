import { IFederatedActor } from '../models/FederatedActor';
import { registerPostFederator } from './serviceRegistry';
import { actorService } from './federation/ActorService';
import { followService } from './federation/FollowService';
import { outboxSyncService } from './federation/OutboxSyncService';
import { inboxProcessingService } from './federation/InboxProcessingService';
import {
  isPermanentlyUnavailableOutboxReason,
  PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS,
  type OutboxSyncResult,
  type OutboxSyncOptions,
  type OutboxSyncFailureReason,
} from './federation/OutboxSyncService';

// Re-export the outbox failure-reason contract from its owning sub-service so
// existing imports of these symbols from FederationService keep resolving.
export {
  isPermanentlyUnavailableOutboxReason,
  PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS,
  type OutboxSyncResult,
  type OutboxSyncOptions,
  type OutboxSyncFailureReason,
};

/**
 * Thin facade over the federation sub-services. Preserves the historical
 * `federationService` public API (every method other modules call) so no call
 * site outside this file changed during the FederationService decomposition.
 *
 * Each method delegates to the owning sub-service:
 *  - {@link ActorService} — actor resolution, caching, refresh, public keys.
 *  - {@link OutboxSyncService} — outbox backfill + boost import.
 *  - {@link FollowService} — outbound delivery + follow/unfollow/accept.
 *  - {@link InboxProcessingService} — inbound activity dispatch + handlers.
 *
 * The singleton is registered as the PostFederator so PostCreationService can
 * federate new local posts without a circular import (see serviceRegistry.ts).
 */
class FederationService {
  // ============================================================
  // Outbox Sync (delegated to OutboxSyncService)
  // ============================================================
  //
  // Thin wrappers preserving the historical FederationService public API for
  // existing call sites (feed.controller, federation routes, job scheduler).

  syncOutboxPosts(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string },
    limit = 20,
  ): Promise<number> {
    return outboxSyncService.syncOutboxPosts(actor, limit);
  }

  syncOutboxPostsDetailed(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string },
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
  // Activity Delivery + Follow Management (delegated to FollowService)
  // ============================================================
  //
  // Thin wrappers preserving the historical FederationService public API for
  // existing call sites (queue workers, job scheduler, federation routes) and
  // for the registered PostFederator used by PostCreationService.

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
    post: { _id: any; content: { text?: string }; hashtags?: string[]; mentions?: string[]; createdAt: string },
    username: string,
  ): Record<string, unknown> {
    return followService.buildCreateNoteActivity(post, username);
  }

  federateNewPost(
    post: { _id: any; content: { text?: string }; hashtags?: string[]; mentions?: string[]; visibility: string; createdAt: string },
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
  // Inbox Processing (delegated to InboxProcessingService)
  // ============================================================

  /**
   * Process an incoming activity from a remote server. Thin wrapper preserving
   * the historical FederationService public API for the queue inbox worker and
   * the federation inbox route.
   */
  processInboxActivity(
    activity: Record<string, any>,
    verifiedActorUri: string,
  ): Promise<void> {
    return inboxProcessingService.processInboxActivity(activity, verifiedActorUri);
  }

  // ============================================================
  // Actor Resolution (delegated to ActorService)
  // ============================================================
  //
  // These thin wrappers keep the historical FederationService public API stable
  // for existing call sites (feed.controller, federation routes, the job
  // scheduler) while the implementation lives in ActorService.

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
}

export const federationService = new FederationService();
// Register with the late-bound service registry so PostCreationService can
// federate new posts without a circular import. See serviceRegistry.ts.
registerPostFederator(federationService);
export default federationService;
