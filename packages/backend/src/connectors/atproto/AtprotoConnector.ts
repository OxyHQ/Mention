import { logger } from '../../utils/logger';
import FederatedFollow from '../../models/FederatedFollow';
import { resolveOxyExternalUser } from '../identity';
import type {
  FetchPostsOptions,
  FetchPostsResult,
  LocalNetworkEvent,
  NetworkConnector,
  NetworkId,
  NormalizedExternalActor,
  ReceiveContext,
} from '../types';
import {
  ATPROTO_ENABLED,
  isAtUri,
  isAtprotoHandle,
  isDid,
} from './constants';
import { resolveIdentity } from './identityResolver';
import { fetchAndUpsertAtprotoProfile } from './profile.mapper';
import { importAuthorFeed } from './post.mapper';

/**
 * The AT Protocol (Bluesky) network connector — READ / DISCOVERY only (C2/C3).
 *
 * It resolves Bluesky handles/DIDs, mirrors profiles into `FederatedActor`
 * (`protocol:'atproto'`) + the shared Oxy identity bridge, and backfills an
 * actor's posts as native `Post` rows (deduped on the AT-URI) through the SAME
 * `getPostCreator().create` path ActivityPub uses.
 *
 * Outbound is intentionally minimal: `deliver({kind:'follow.add'})` records a
 * LOCAL subscription (no Follow is written to the atproto network) and triggers a
 * post backfill; `post.create` is a no-op. The C4 bridge (`bridge/`) makes a
 * local user discoverable/readable FROM atproto (be-discovered via did:web) — it
 * does NOT publish posts INTO a foreign PDS (that is the documented outbound
 * product seam, `AtprotoBridgeOutboundSeam` in `bridge/index.ts`). The connector
 * NEVER uses `@atproto/api`; every network read goes through the SSRF-safe XRPC
 * client.
 */
class AtprotoConnector implements NetworkConnector {
  readonly id: NetworkId = 'atproto';

  get enabled(): boolean {
    return ATPROTO_ENABLED;
  }

  /** True for an atproto DID, an AT-URI, or a bare handle (DNS name, no `@`). */
  matches(subject: string): boolean {
    const value = subject.trim();
    return isDid(value) || isAtUri(value) || isAtprotoHandle(value);
  }

  /**
   * Resolve a handle / DID / AT-URI to a normalized actor (handle→DID, then
   * `app.bsky.actor.getProfile`), upserting the `FederatedActor` row and the
   * Oxy identity it maps to.
   */
  async resolve(handle: string): Promise<NormalizedExternalActor | null> {
    const value = handle.trim();
    // Resolve to a DID first (handles, DIDs, and AT-URI authorities all funnel
    // through identity resolution); getProfile then accepts the DID.
    const identity = await resolveIdentity(this.toIdentityInput(value));
    if (!identity) return null;
    return this.fetchProfile(identity.did);
  }

  /** Fetch + normalize an atproto profile by its DID (or handle). */
  fetchProfile(externalId: string): Promise<NormalizedExternalActor | null> {
    return fetchAndUpsertAtprotoProfile(externalId);
  }

  /**
   * Backfill an actor's recent posts. Resolves/refreshes the actor (so its Oxy
   * user is known — no orphan posts), then imports `app.bsky.feed.getAuthorFeed`.
   */
  async fetchPosts(externalId: string, opts: FetchPostsOptions = {}): Promise<FetchPostsResult> {
    const actor = await fetchAndUpsertAtprotoProfile(externalId);
    if (!actor) return { posts: [] };
    if (!actor.oxyUserId) {
      logger.warn(`[atproto] fetchPosts: ${externalId} has no resolved Oxy user; skipping backfill`);
      return { posts: [] };
    }
    const { posts, cursor } = await importAuthorFeed(actor, { limit: opts.limit, cursor: opts.cursor });
    return { posts, cursor };
  }

  /** Deliver a local domain event. */
  async deliver(event: LocalNetworkEvent): Promise<void> {
    switch (event.kind) {
      case 'post.create':
        // Mention does NOT publish posts INTO a foreign atproto PDS. The C4
        // bridge is BE-DISCOVERED (the user's repo is hosted here and read via
        // `bridge/`); foreign-PDS publishing is the documented outbound product
        // seam (`AtprotoBridgeOutboundSeam`), not wired. No-op.
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

  /** atproto has no inbound push transport in C2 — discovery is pull-only. */
  async receive(_payload: unknown, _ctx: ReceiveContext): Promise<void> {
    // No-op: there is no signed atproto inbox to process. Posts arrive via the
    // pull-based `fetchPosts` backfill, not an inbound delivery.
  }

  /** Resolve/mint the Oxy user this atproto actor maps to. */
  mapIdentity(actor: NormalizedExternalActor): Promise<string | null> {
    return resolveOxyExternalUser(actor);
  }

  /**
   * Record a LOCAL subscription to an atproto actor and backfill its posts. No
   * Follow is delivered to the atproto network in C2 (that is the C4 bridge); the
   * subscription merges the actor's posts into the viewer's feed exactly like the
   * ActivityPub `/federation/following` path.
   */
  private async followActor(localOxyUserId: string, targetDid: string): Promise<void> {
    // Resolve the actor first so `targetDid` is canonical (a handle/AT-URI is
    // normalized to its DID) and its Oxy user is minted before the backfill.
    const actor = await this.resolve(targetDid);
    const canonicalDid = actor?.externalId ?? targetDid;

    await FederatedFollow.findOneAndUpdate(
      { localUserId: localOxyUserId, remoteActorUri: canonicalDid, direction: 'outbound' },
      { $set: { status: 'accepted', network: 'atproto' } },
      { upsert: true, returnDocument: 'after' },
    );

    // Backfill the followed actor's recent posts in the background.
    if (actor?.oxyUserId) {
      void importAuthorFeed(actor, { limit: 20 }).catch((err) => {
        logger.warn(`[atproto] follow backfill failed for ${canonicalDid}`, err);
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
    const actor = await this.resolve(targetDid);
    const canonicalDid = actor?.externalId ?? targetDid;

    await FederatedFollow.deleteOne({
      localUserId: localOxyUserId,
      remoteActorUri: canonicalDid,
      direction: 'outbound',
    });
  }

  /** Strip an `at://<authority>/...` to its authority so identity resolution works. */
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
