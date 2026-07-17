/**
 * Federated profile sync-on-view.
 *
 * Viewing a remote profile is how Mention DISCOVERS that profile's posts: there
 * is no push subscription to an actor we do not follow, so the first time a
 * federated author's profile is opened we resolve the actor and pull their
 * ActivityPub outbox (or, for atproto, their author feed) into local posts.
 *
 * This is a SIDE EFFECT of serving an author feed, not part of building it. The
 * contract with the feed layer is therefore deliberately narrow:
 *
 *   `syncOnProfileView(oxyUserId)` → `pending`
 *
 * The ONLY request-path work is a single indexed `FederatedActor.findOne` to
 * decide whether to report the feed as `pending`; ALL federation network I/O
 * (Oxy user lookup, actor fetch, outbox sync, media downloads) runs detached.
 * A feed response must never block on remote I/O.
 *
 * `pending: true` tells the client "posts are still being imported" so it shows
 * a loading state and refetches shortly, instead of rendering an empty profile.
 */

import { normalizeInlineText, type User } from '@oxyhq/core';
import { Post } from '../models/Post';
import FederatedActor, { IFederatedActor } from '../models/FederatedActor';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { activityPubConnector, isPermanentlyUnavailableOutboxReason } from './activitypub/ActivityPubConnector';
import { FEDERATION_ENABLED } from './activitypub/constants';
import {
  isWithinOutboxSyncCooldown,
  shouldForceUntrackedOutboxSync,
} from './activitypub/outboxSyncCooldown';
import { ATPROTO_ENABLED } from './atproto/constants';
import { syncAtprotoProfileGraph } from './atproto/profileGraph';
import { connectorRegistry } from './index';

/**
 * Minimum interval between background outbox re-syncs for the same federated
 * actor. Profile views trigger a background outbox sync; without a cooldown
 * every view re-fetches and re-dedupes the entire outbox. Mirrors the
 * ACTOR_REFRESH_MIN_INTERVAL_MS guard used for full-actor refreshes.
 */
const OUTBOX_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Cached federated actors older than this are refreshed before a profile outbox
 * sync. Profile sync runs off the request path, so it can afford to fetch the
 * actor document first and use the advertised outbox instead of stale guesses.
 */
const FEDERATED_ACTOR_PROFILE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Max number of recent outbox posts to pull per background profile sync. */
const OUTBOX_SYNC_LIMIT = 20;

class FederatedProfileSync {
  /**
   * Entry point for the feed layer: an author feed was just served EMPTY on its
   * first page for `oxyUserId`.
   *
   * Kicks off the background sync (fire-and-forget) and returns whether the
   * feed should be reported as `pending`. Awaits exactly one cheap indexed
   * lookup; never performs network I/O on the caller's path and never throws.
   */
  async syncOnProfileView(oxyUserId: string): Promise<boolean> {
    if (!FEDERATION_ENABLED && !ATPROTO_ENABLED) return false;

    let cachedActor: IFederatedActor | null = null;
    try {
      cachedActor = await FederatedActor.findOne({ oxyUserId }).lean<IFederatedActor>();
    } catch (error) {
      // A failed actor lookup must not fail the feed — it only costs us the
      // background sync for this view.
      logger.warn(`[FedSync] actor lookup failed for userId=${oxyUserId}`, error);
      return false;
    }

    if (cachedActor) {
      // Known federated user with no local posts yet → kick off the background
      // outbox sync + actor refresh and tell the client the feed is being
      // populated so it polls, unless a recent sync already proved there are no
      // importable outbox items.
      this.runInBackground(oxyUserId, cachedActor);
      return this.shouldReportPending(cachedActor);
    }

    // No cached actor row. This is either a local user with a genuinely empty
    // feed (the common case — it must stay NOT pending, or every empty local
    // profile would poll) or a federated user we have never resolved. Resolve
    // the identity in the background (a single Oxy lookup, off the request
    // path); if it turns out to be federated, the background task creates the
    // actor row and syncs, and the next fetch sees `pending`/posts.
    this.runInBackground(oxyUserId, undefined);
    return false;
  }

  /**
   * Fire-and-forget background sync for a (potentially) federated profile.
   *
   * Performs ALL federation network I/O off the client request path:
   *  1. Resolves the Oxy user to find its `federation.actorUri` (only when we
   *     don't already have a cached actor row).
   *  2. Upserts a minimal FederatedActor (outbox URL) so the outbox sync can run
   *     immediately without waiting on a full actor fetch.
   *  3. Syncs the actor's outbox into local posts.
   *  4. Enqueues a full background actor refresh so avatar/banner/displayName
   *     populate (and refresh over time) for viewed profiles — followed or not.
   *
   * Never throws; all errors are logged. Returns void synchronously to the
   * caller (the work runs detached).
   */
  private runInBackground(syncUserId: string, cachedActor?: IFederatedActor): void {
    void (async () => {
      try {
        // Dispatch by the cached actor's network. atproto profiles backfill
        // through the atproto connector's pull-based author feed (no AP outbox
        // dance); the rest of this method is the ActivityPub outbox flow.
        if (cachedActor?.protocol === 'atproto') {
          if (cachedActor.uri) {
            const connector = connectorRegistry.connectorFor(cachedActor.uri);
            if (connector) {
              try {
                await connector.fetchPosts(cachedActor.uri, { limit: OUTBOX_SYNC_LIMIT });
              } catch (fetchErr) {
                // A failed backfill is still a COMPLETED sync attempt: stamp it
                // below so the pending check can clear instead of polling forever.
                const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
                logger.warn(`[FedSync] atproto backfill failed for ${cachedActor.acct}: ${message}`);
              }
            }

            // Discover the actor's starter packs + external feed references the
            // SAME way posts are discovered — on profile view, best-effort and
            // DETACHED so it never delays or fails the (already-detached) post
            // backfill or its cooldown stamp below. Gated on a resolved Oxy owner
            // (no orphan): a re-resolved atproto actor carries `oxyUserId`; when it
            // does not yet, the next view (after the backfill stamps it) picks it up.
            if (ATPROTO_ENABLED && cachedActor.oxyUserId) {
              const graphDid = cachedActor.uri;
              const graphOwner = cachedActor.oxyUserId;
              void syncAtprotoProfileGraph(graphDid, graphOwner).catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn(`[FedSync] atproto graph sync failed for ${cachedActor.acct}: ${message}`);
              });
            }
          }
          // Stamp the post-backfill time so `shouldReportPending` can clear. The
          // atproto path never touches the ActivityPub outbox code that normally
          // stamps `lastOutboxSyncAt`, so without this an atproto profile with an
          // empty local feed would report `pending:true` on EVERY view forever.
          await this.stampPostBackfill(cachedActor._id);
          return;
        }

        if (!FEDERATION_ENABLED) return;

        let actor: IFederatedActor | null = cachedActor ?? null;
        let refreshedActorForSync = false;
        let oxyIdentity: { actorUri?: string; acctHint?: string } | undefined;

        const getOxyIdentity = async (): Promise<{ actorUri?: string; acctHint?: string }> => {
          if (oxyIdentity) return oxyIdentity;
          // Federated profile lookup is public — use the service client so it
          // works for unauthenticated viewers and avoids per-request token setup.
          const oxyLookupClient = getServiceOxyClient();
          const oxyUser: User = await oxyLookupClient.getUserById(syncUserId);
          oxyIdentity = {
            actorUri: typeof oxyUser.federation?.actorUri === 'string'
              ? oxyUser.federation.actorUri
              : undefined,
            acctHint: typeof oxyUser.username === 'string' && oxyUser.username.includes('@')
              ? oxyUser.username
              : undefined,
          };
          logger.info(`[FedSync] oxyUser.type=${oxyUser.type} federation.actorUri=${oxyIdentity.actorUri ?? 'missing'} username=${oxyIdentity.acctHint ?? 'missing'}`);
          return oxyIdentity;
        };

        const stampActorOxyUserId = async (): Promise<void> => {
          if (!actor || actor.oxyUserId) return;
          await FederatedActor.updateOne({ _id: actor._id }, { $set: { oxyUserId: syncUserId } });
          actor.oxyUserId = syncUserId;
        };

        logger.info(`[FedSync] background sync userId=${syncUserId} existingActor=${!!actor} outboxUrl=${actor?.outboxUrl ?? 'none'}`);

        if (!actor) {
          const { actorUri, acctHint } = await getOxyIdentity();
          if (!actorUri) {
            // Local user with an empty feed — nothing to sync.
            return;
          }

          // Fetch the real actor document so we use its advertised `outbox`
          // (and `inbox`) endpoints. Guessing `actorUri + '/outbox'` only happens
          // to work on Mastodon-style layouts and breaks non-Mastodon servers
          // (PeerTube, Lemmy, some Pleroma) whose outbox lives elsewhere.
          // `fetchRemoteActor` upserts the FederatedActor with the canonical
          // `outboxUrl`/`inboxUrl` taken from `actor.outbox`/`actor.inbox`.
          actor = await activityPubConnector.fetchRemoteActor(actorUri, false, acctHint);

          if (!actor) {
            // The remote actor fetch failed (network error, blocked domain,
            // unauthorized fetch, etc.). Fall back to a minimal FederatedActor
            // with a guessed outbox so the sync can still attempt Mastodon-style
            // layouts; the enqueued background refresh will correct it later.
            const domain = new URL(actorUri).hostname;
            // The handle hint is remote text, and this row is written straight to
            // Mongo: the schema normalizes NOTHING (see `models/FederatedActor.ts`),
            // so this writer applies the canonical rule itself — a padded hint must
            // not become a padded username in a unique index.
            const username = normalizeInlineText((acctHint || '').split('@')[0]) || 'unknown';
            const acct = `${username}@${domain}`;
            const fallbackOutboxUrl = `${actorUri}${actorUri.endsWith('/') ? '' : '/'}outbox`;
            logger.info(`[FedSync] fetchRemoteActor failed for ${actorUri}; creating minimal FederatedActor with fallback outboxUrl=${fallbackOutboxUrl}`);
            actor = await FederatedActor.findOneAndUpdate(
              { uri: actorUri },
              {
                $set: {
                  uri: actorUri,
                  username,
                  domain,
                  acct,
                  inboxUrl: `${actorUri}${actorUri.endsWith('/') ? '' : '/'}inbox`,
                  outboxUrl: fallbackOutboxUrl,
                  oxyUserId: syncUserId,
                  lastFetchedAt: new Date(0), // Mark stale so the refresh below runs
                },
                $setOnInsert: { type: 'Person', manuallyApprovesFollowers: false, discoverable: true, memorial: false, suspended: false, fields: [], followersCount: 0, followingCount: 0, postsCount: 0 },
              },
              { upsert: true, returnDocument: 'after', lean: true },
            ) as IFederatedActor | null;
          } else {
            await stampActorOxyUserId();
          }
        } else {
          const { actorUri, acctHint } = await getOxyIdentity();
          const actorUriChanged = Boolean(actorUri && actorUri !== actor.uri);
          const actorAcctChanged = Boolean(acctHint && actor.acct?.toLowerCase() !== acctHint.toLowerCase());
          if (actorUriChanged || actorAcctChanged || this.shouldRefreshActorBeforeOutboxSync(actor)) {
            const refreshUri = actorUri || actor.uri;
            const refreshAcct = acctHint || actor.acct;
            logger.info(`[FedSync] refreshing cached actor before outbox sync for ${actor.acct}; actorUriChanged=${actorUriChanged} actorAcctChanged=${actorAcctChanged}`);
            const refreshed = await activityPubConnector.fetchRemoteActor(refreshUri, false, refreshAcct);
            if (refreshed) {
              actor = refreshed;
              refreshedActorForSync = true;
              await stampActorOxyUserId();
            } else {
              logger.info(`[FedSync] cached actor refresh failed before outbox sync for ${actor.acct}; using cached outboxUrl=${actor.outboxUrl ?? 'none'}`);
            }
          }
        }

        if (!actor) return;

        // Enqueue a full actor refresh (avatar/banner/displayName) for the viewed
        // profile. Guarded against refresh storms inside the ActivityPub connector.
        activityPubConnector.refreshActorInBackground(actor.uri, actor);

        if (!actor.outboxUrl) return;

        const outboxStatus = this.currentOutboxBackfillStatus(actor);
        if (outboxStatus === 'unavailable') {
          logger.info(`[FedSync] outbox sync skipped (unavailable) for ${actor.acct}`);
          return;
        }

        // Cooldown: skip the (expensive) outbox re-fetch+dedupe if we synced this
        // actor's outbox within the cooldown window. Profile views are frequent;
        // the outbox rarely changes between back-to-back views.
        const shouldClassifyUntrackedOutbox = shouldForceUntrackedOutboxSync({
          outboxStatus,
          postsCount: actor.postsCount,
          lastOutboxSyncAt: actor.lastOutboxSyncAt,
          cooldownMs: OUTBOX_SYNC_MIN_INTERVAL_MS,
        });
        const syncedRecently = !refreshedActorForSync
          && !shouldClassifyUntrackedOutbox
          && isWithinOutboxSyncCooldown(actor.lastOutboxSyncAt, OUTBOX_SYNC_MIN_INTERVAL_MS);
        if (syncedRecently) {
          logger.info(`[FedSync] outbox sync skipped (cooldown) for ${actor.acct}`);
          return;
        }

        // Ensure the actor has oxyUserId before syncing so posts get the right author
        if (!actor.oxyUserId) {
          await FederatedActor.updateOne({ _id: actor._id }, { $set: { oxyUserId: syncUserId } });
          actor.oxyUserId = syncUserId;
        }

        const syncResult = await activityPubConnector.syncOutboxPostsDetailed(actor, OUTBOX_SYNC_LIMIT);
        const syncedCount = syncResult.syncedCount;
        logger.info(`[FedSync] syncOutboxPosts returned ${syncedCount} for ${actor.acct}`);
        if (isPermanentlyUnavailableOutboxReason(syncResult.reason)) {
          await activityPubConnector.markOutboxBackfillUnavailable(actor, syncResult.reason);
        } else if (syncResult.shouldStampCooldown) {
          // Stamp the sync time so subsequent views honour the cooldown only
          // after a fetch that actually exposed an inspectable outbox.
          await FederatedActor.updateOne(
            { _id: actor._id },
            { $set: { lastOutboxSyncAt: new Date() } },
          );
        } else {
          logger.info(`[FedSync] not stamping outbox cooldown for ${actor.acct}; reason=${syncResult.reason ?? 'unknown'}`);
        }

        // Backfill oxyUserId on any posts that were stored without it
        if (syncedCount > 0) {
          await Post.updateMany(
            { 'federation.activityId': { $regex: `^${actor.uri}` }, oxyUserId: null },
            { $set: { oxyUserId: syncUserId } },
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedSync] background profile sync failed for userId=${syncUserId}: ${message}`);
      }
    })();
  }

  /**
   * Stamp `lastOutboxSyncAt = now` on a federated actor after a post backfill.
   *
   * The field name is ActivityPub-flavoured, but `shouldReportPending` reads it
   * as the single "when did we last try to import this actor's posts" signal for
   * BOTH protocols. The atproto backfill (`fetchPosts`) never touches the AP
   * outbox code that stamps it, so this is the atproto path's stamp point. An
   * empty import is still a COMPLETED sync, so the caller stamps regardless of
   * how many posts were imported. Fail-soft: a stamp failure only costs one more
   * poll, never the detached task.
   */
  private async stampPostBackfill(actorId: IFederatedActor['_id']): Promise<void> {
    try {
      await FederatedActor.updateOne({ _id: actorId }, { $set: { lastOutboxSyncAt: new Date() } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedSync] failed to stamp post backfill for actor ${String(actorId)}: ${message}`);
    }
  }

  private shouldRefreshActorBeforeOutboxSync(actor: IFederatedActor): boolean {
    if (!actor.outboxUrl) return true;
    const fetchedAt = actor.lastFetchedAt?.getTime();
    if (typeof fetchedAt !== 'number') return true;
    if (fetchedAt <= 0) return true;
    return Date.now() - fetchedAt > FEDERATED_ACTOR_PROFILE_STALE_MS;
  }

  private currentOutboxBackfillStatus(actor: IFederatedActor): string | undefined {
    if (!actor.outboxUrl) return undefined;
    if (actor.outboxBackfill?.outboxUrl !== actor.outboxUrl) return undefined;
    return actor.outboxBackfill?.status;
  }

  /**
   * Whether an empty profile feed for this KNOWN federated actor is worth telling
   * the client to poll for. A finished (`complete`) or permanently unreachable
   * (`unavailable`) outbox will never produce posts, so the client must render
   * the empty profile instead of spinning.
   */
  private shouldReportPending(actor: IFederatedActor): boolean {
    // An atproto actor with zero upstream posts has nothing to import, so it
    // must never poll. Short-circuit the common empty case on the VERY first
    // view — before the background backfill has stamped `lastOutboxSyncAt` — so
    // a zero-post Bluesky profile renders empty immediately instead of spinning.
    // (`postsCount` is populated from the Bluesky profile on actor upsert.)
    if (actor.protocol === 'atproto' && (actor.postsCount ?? 0) === 0) return false;

    const outboxStatus = this.currentOutboxBackfillStatus(actor);
    if (outboxStatus === 'unavailable' || outboxStatus === 'complete') return false;
    if (outboxStatus === 'pending') return true;

    const lastSyncMs = actor.lastOutboxSyncAt?.getTime();
    if (typeof lastSyncMs !== 'number') return true;
    return Date.now() - lastSyncMs >= OUTBOX_SYNC_MIN_INTERVAL_MS;
  }
}

export const federatedProfileSync = new FederatedProfileSync();
