import type { PostContent } from '@mention/shared-types';
import type {
  FetchPostsOptions,
  FetchPostsResult,
  LocalNetworkEvent,
  NetworkConnector,
  NormalizedExternalActor,
  ReceiveContext,
} from '@oxy.so/federation';
import type { FederatedActorRecord } from '../../db/federation/actorRecord';
import { findActorByUri } from '../../db/federation/actorRepository';
import { deleteFollow, upsertOutboundAcceptedSubscription } from '../../db/federation/followRepository';
import { logger } from '../../utils/logger';
import { resolveOxyExternalUser } from '../identity';
import { INSTAGRAM_GRAPH_NETWORK_ID, isInstagramGraphActorUri, isInstagramGraphEnabled } from './constants';
import { fetchAndUpsertInstagramGraphActor } from './profile';
import {
  isInstagramIdentityActor,
  runPeriodicInstagramSync,
  syncInstagramActor,
  syncInstagramActorInBackground,
} from './sync';

/**
 * The Instagram connector — Meta's Graph API (Business Discovery), READ ONLY.
 *
 * ## Two roads, one account
 *
 * The kilogram.makeup ActivityPub bridge is what Oxy maps `<u>@instagram.com` to,
 * and it stays the PREFERRED road for identity and for new posts: a follow goes to
 * it, and it pushes what it sees after that. What it never does is serve history
 * — its outbox is a bare `{"type":"Collection"}` — so a kilogram profile opens
 * empty and stays empty until someone follows and the account posts again. This
 * connector fills that gap: for any actor whose IDENTITY is on instagram.com it
 * reads the account's media from the Graph API and imports it, deduped against
 * whatever the bridge pushes (`shared/instagramSourceKey.ts`).
 *
 * When no bridge answers for an account at all, Oxy resolves it through the
 * Graph API itself and hands Mention an `instagram-graph:<ig-user-id>` actor.
 * That actor is THIS connector's (`matches`, `fetchProfile`, `deliver`).
 *
 * ## What it does not do
 *
 * Instagram accepts nothing from a third party, so `deliver` records a LOCAL
 * subscription for a follow (like the atproto connector) and drops every write
 * event; `receive` is a no-op — there is no push transport. Business Discovery
 * only sees Business and Creator accounts; a personal account is remembered as
 * `not_business` and re-asked weekly.
 *
 * Inert unless `INSTAGRAM_GRAPH_ENABLED` AND both Meta credentials are set.
 */
class InstagramGraphConnector implements NetworkConnector<PostContent> {
  readonly id = INSTAGRAM_GRAPH_NETWORK_ID;

  get enabled(): boolean {
    return isInstagramGraphEnabled();
  }

  /** Only this connector's own URIs: `instagram-graph:<numeric id>`. */
  matches(subject: string): boolean {
    return isInstagramGraphActorUri(subject.trim());
  }

  /**
   * A `<u>@instagram.com` handle is resolved by Oxy (`/federation/resolve`), which
   * decides between the bridge and the Graph API; this connector only resolves
   * the URIs Oxy hands back.
   */
  async resolve(handle: string): Promise<NormalizedExternalActor | null> {
    const value = handle.trim();
    return this.matches(value) ? this.fetchProfile(value) : null;
  }

  fetchProfile(externalId: string): Promise<NormalizedExternalActor | null> {
    if (!this.enabled) return Promise.resolve(null);
    return fetchAndUpsertInstagramGraphActor(externalId);
  }

  /** One interactive sync (lease + cooldown + budget apply); the posts it stored. */
  async fetchPosts(externalId: string, _opts: FetchPostsOptions = {}): Promise<FetchPostsResult> {
    if (!this.enabled) return { posts: [] };
    let actor = await findActorByUri(externalId);
    if (!actor && this.matches(externalId)) {
      await this.fetchProfile(externalId);
      actor = await findActorByUri(externalId);
    }
    if (!actor?.oxyUserId || !isInstagramIdentityActor(actor)) return { posts: [] };
    const result = await syncInstagramActor(actor, 'profile_view');
    return { posts: result?.posts ?? [] };
  }

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
        // Instagram accepts no writes from a third party. No-op.
        return;
      case 'follow.add':
        await this.followActor(event.localOxyUserId, event.targetActorUri);
        return;
      case 'follow.remove':
        await deleteFollow(event.localOxyUserId, event.targetActorUri.trim(), 'outbound');
        return;
      default: {
        const exhaustive: never = event;
        throw new Error(`InstagramGraphConnector: unhandled local event ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** No push transport: posts arrive only through the pull-based sync. */
  async receive(_payload: unknown, _ctx: ReceiveContext): Promise<void> {
    // No-op.
  }

  mapIdentity(actor: NormalizedExternalActor): Promise<string | null> {
    return resolveOxyExternalUser(actor);
  }

  /**
   * A local subscription (nothing is sent to Instagram) that makes the account a
   * periodic-sync candidate, plus the follow backfill.
   */
  private async followActor(localOxyUserId: string, targetActorUri: string): Promise<void> {
    const actorUri = targetActorUri.trim();
    if (!this.matches(actorUri)) return;
    await upsertOutboundAcceptedSubscription(localOxyUserId, actorUri, INSTAGRAM_GRAPH_NETWORK_ID);
    if (!this.enabled) return;
    let actor = await findActorByUri(actorUri);
    if (!actor) {
      await this.fetchProfile(actorUri);
      actor = await findActorByUri(actorUri);
    }
    if (actor) syncInstagramActorInBackground(actor, 'follow');
  }

  // ── Product-facing hooks (the ONLY surface outside connectors/instagram/) ──

  /**
   * An Instagram-identity profile was opened with nothing to show: sync it in
   * the background (lease, cooldown and budget permitting). Detached — no I/O on
   * the caller's path.
   */
  syncOnProfileView(actor: Parameters<typeof syncInstagramActor>[0]): void {
    if (!this.enabled || !actor.oxyUserId || !isInstagramIdentityActor(actor)) return;
    syncInstagramActorInBackground(actor, 'profile_view');
  }

  /** A local user followed `actorUri` over ANY connector; backfill it if it is Instagram. */
  async backfillOnFollow(actorUri: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const actor = await findActorByUri(actorUri);
      if (actor?.oxyUserId && isInstagramIdentityActor(actor)) {
        syncInstagramActorInBackground(actor, 'follow');
      }
    } catch (err) {
      logger.warn('[instagram] follow backfill lookup failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The periodic job body (`syncInstagramFollowedAccounts`). */
  syncFollowedAccounts(): Promise<{ synced: number; imported: number }> {
    return runPeriodicInstagramSync();
  }

  /**
   * Should an EMPTY profile of this actor tell the reader "posts are on their
   * way"? Only while a first Graph sync has never finished: once one has, the
   * posts it could import are already here, and answering `pending` again every
   * cooldown would make the profile flicker between a spinner and empty forever
   * (the kilogram outbox never fills). A remembered `not_business` never waits.
   */
  isProfileSyncPending(actor: Pick<FederatedActorRecord, 'protocol' | 'networkAcct' | 'oxyUserId' | 'instagramGraphSyncedAt'>): boolean {
    if (!this.enabled || !actor.oxyUserId || !isInstagramIdentityActor(actor)) return false;
    return actor.instagramGraphSyncedAt === undefined;
  }

  /** Whether `actor` is one this connector can read posts for. */
  isInstagramIdentity(actor: Parameters<typeof isInstagramIdentityActor>[0]): boolean {
    return isInstagramIdentityActor(actor);
  }
}

export const instagramGraphConnector = new InstagramGraphConnector();
export { isInstagramGraphEnabled };
export default instagramGraphConnector;
