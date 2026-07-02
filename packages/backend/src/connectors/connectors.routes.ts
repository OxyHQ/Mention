import { Router, Response } from 'express';
import { z } from 'zod';
import { getRequiredOxyUserId, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { User as OxyUser } from '@oxyhq/core';
import { PostVisibility } from '@mention/shared-types';
import { logger } from '../utils/logger';
import { activityPubConnector, isPermanentlyUnavailableOutboxReason } from './activitypub/ActivityPubConnector';
import FederatedActor from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import { Post } from '../models/Post';
import { FEDERATION_ENABLED } from './activitypub/constants';
import { ATPROTO_ENABLED, isDid, isAtUri, isAtprotoHandle } from './atproto/constants';
import { normalizeFederatedAcct } from './activitypub/helpers';
import { isAbsoluteHttpUrl } from './shared/url';
import { connectorRegistry } from './index';
import { classifyQuery } from './resolve';
import type { NetworkConnector } from './types';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient, getServiceOxyClient } from '../utils/oxyHelpers';
import { apiRateLimiter } from '../middleware/rateLimiter';
import { isFediverseSharingEnabled } from '../services/fediverseSharing';

/**
 * Cross-network connector API (mounted at `/federation`, URL kept stable for the
 * frontend). Generalized from the ActivityPub-only `federation.api.routes`:
 * follow / unfollow now dispatch to the connector that owns the target's
 * protocol, `/resolve` performs unified cross-network handle resolution, and the
 * `actor/posts` empty-state sync dispatches by `FederatedActor.protocol`. The
 * `following`/`followers` list queries are already protocol-agnostic.
 */
const router = Router();

// Rate-limit all connector API routes (200 req/min per user or IP)
router.use(apiRateLimiter);

// --- Zod schemas ---

/**
 * A follow/unfollow target. A plain `.url()` rejects the legitimate non-URL
 * identifier forms the connectors accept, so validate against the EXACT set each
 * connector's `matches()` claims — an ActivityPub actor URI (absolute http(s)
 * URL) or fediverse acct (`@user@host`), or an atproto DID / AT-URI / bare
 * handle — instead of a blanket string that would let arbitrary input reach DB
 * queries and connector dispatch.
 */
function isFollowableActorRef(value: string): boolean {
  return (
    isAbsoluteHttpUrl(value)
    || Boolean(normalizeFederatedAcct(value))
    || isDid(value)
    || isAtUri(value)
    || isAtprotoHandle(value)
  );
}

/**
 * A STORED `FederatedActor.uri` is always canonical: an ActivityPub actor URI
 * (absolute http(s) URL) or an atproto DID — never a handle/acct/AT-URI.
 */
function isStoredActorUri(value: string): boolean {
  return isAbsoluteHttpUrl(value) || isDid(value);
}

/**
 * A bare local Oxy username (no `@host`, no scheme, no path). `classifyQuery`
 * routes these to a 404 ("not an external handle"); accepting the shape here
 * preserves that documented behavior instead of 400-ing a valid username.
 */
const LOCAL_USERNAME_RE = /^@?[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,62}$/;

/**
 * A `/resolve` query: an external identifier the connectors resolve (AP acct /
 * atproto handle / DID / AT-URI) OR a bare local username. Rejecting everything
 * else (whitespace, URL schemes, path/query chars) keeps junk out of the
 * downstream network dispatch (XRPC / WebFinger / `https://<handle>/...` / DNS).
 */
function isResolvableQuery(value: string): boolean {
  return (
    Boolean(normalizeFederatedAcct(value))
    || isAtprotoHandle(value)
    || isDid(value)
    || isAtUri(value)
    || LOCAL_USERNAME_RE.test(value)
  );
}

const actorRefSchema = z.object({
  actorUri: z.string().min(1).max(2048).refine(isFollowableActorRef, {
    message: 'actorUri must be an ActivityPub actor URI/handle or an atproto DID/handle',
  }),
});

const actorPostsQuerySchema = z.object({
  uri: z.string().min(1).max(2048).refine(isStoredActorUri, {
    message: 'uri must be an ActivityPub actor URI or an atproto DID',
  }),
  cursor: z.string().datetime({ offset: true }).optional(),
});

const resolveQuerySchema = z.object({
  handle: z.string().min(1).max(512).refine(isResolvableQuery, {
    message: 'handle must be a fediverse acct, atproto handle/DID, or username',
  }),
});

// --- Helpers ---

/** Guard: return 404 if NO external network is enabled. */
function requireAnyConnector(res: Response): boolean {
  if (!FEDERATION_ENABLED && !ATPROTO_ENABLED) {
    res.status(404).json({ error: 'Federation disabled' });
    return false;
  }
  return true;
}

/**
 * Resolve the authenticated Oxy user id, or write a 401 and return null.
 *
 * Identity resolution is owned entirely by `@oxyhq/core/server`
 * (`getRequiredOxyUserId`, which throws when unauthenticated). This wrapper only
 * translates that into an HTTP 401 — these routes are mounted under `optionalAuth`.
 */
function resolveUserOr401(req: AuthRequest, res: Response): string | null {
  try {
    return getRequiredOxyUserId(req);
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
}

/**
 * Resolve the connector that owns a follow/unfollow target. Prefers the stored
 * `FederatedActor.protocol` (authoritative once an actor is known), falling back
 * to shape-based `matches` (an http URI → ActivityPub, a DID → atproto).
 */
async function resolveTargetConnector(target: string): Promise<NetworkConnector | undefined> {
  const stored = await FederatedActor.findOne({ uri: target }).select('protocol').lean();
  if (stored?.protocol) {
    const byProtocol = connectorRegistry.list().find((connector) => connector.id === stored.protocol);
    if (byProtocol) return byProtocol;
  }
  return connectorRegistry.connectorFor(target);
}

function hasUnavailableCurrentOutbox(actor: { outboxUrl?: string; outboxBackfill?: { outboxUrl?: string; status?: string } }): boolean {
  return Boolean(
    actor.outboxUrl
    && actor.outboxBackfill?.outboxUrl === actor.outboxUrl
    && actor.outboxBackfill.status === 'unavailable',
  );
}

/**
 * Resolve the canonical Oxy `name.displayName` for a batch of federated actors,
 * keyed by actor URI.
 *
 * Display names are owned by the Oxy API (`name.displayName`) and are the SINGLE
 * source of truth — Mention never reads a local `FederatedActor` name copy.
 * Actors are batch-resolved by their `oxyUserId` through the service client
 * (mirrors `PostHydrationService.resolveUserSummaries`). An actor whose Oxy user
 * is missing from the response is omitted, so the caller falls back to the
 * actor's `@<acct>` handle.
 */
async function resolveActorDisplayNamesByUri(
  actors: Array<{ uri: string; oxyUserId?: string }>,
): Promise<Map<string, string>> {
  const byUri = new Map<string, string>();
  const oxyUserIds = Array.from(
    new Set(actors.map((a) => a.oxyUserId).filter((id): id is string => Boolean(id))),
  );
  if (oxyUserIds.length === 0) return byUri;

  let users: OxyUser[] = [];
  try {
    users = await getServiceOxyClient().getUsersByIds(oxyUserIds);
  } catch (err) {
    logger.warn('Failed to resolve Oxy display names for federated actors:', err);
    return byUri;
  }

  const nameByOxyId = new Map<string, string>();
  for (const user of users) {
    const id = String((user as { id?: unknown }).id ?? '');
    const displayName = user.name.displayName;
    if (id && displayName) nameByOxyId.set(id, displayName);
  }

  for (const actor of actors) {
    if (!actor.oxyUserId) continue;
    const displayName = nameByOxyId.get(actor.oxyUserId);
    if (displayName) byUri.set(actor.uri, displayName);
  }
  return byUri;
}

// --- Routes ---
// Note: Local profile search/lookup is handled by OxyHQServices
// (/profiles/search, /profiles/resolve). These routes handle cross-network
// federation operations (resolve, follows, posts).

/**
 * GET /federation/resolve?handle=...
 *
 * Unified cross-network handle resolution. Classifies the query (ActivityPub /
 * atproto / local), dispatches to the connector that owns it, and returns a
 * normalized actor card with the Oxy user it maps to plus the viewer's follow
 * state. Local Oxy handles are out of scope here (resolved by Oxy `/profiles`).
 */
router.get('/resolve', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;

  const parsed = resolveQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const network = classifyQuery(parsed.data.handle);
  if (network === 'local') {
    return res.status(404).json({ error: 'Not an external handle' });
  }

  try {
    const actor = await connectorRegistry.resolve(parsed.data.handle);
    if (!actor) return res.status(404).json({ error: 'Actor not found' });

    // Follow state for the (optional) viewer — keyed on the actor's protocol id.
    let followed = false;
    const viewerId = req.user?.id;
    if (viewerId) {
      const follow = await FederatedFollow.findOne({
        localUserId: viewerId,
        remoteActorUri: actor.externalId,
        direction: 'outbound',
        status: { $in: ['accepted', 'pending'] },
      }).lean();
      followed = Boolean(follow);
    }

    return res.json({
      network: actor.network,
      externalId: actor.externalId,
      handle: actor.handle,
      displayName: actor.displayName,
      avatarUrl: actor.avatarUrl,
      oxyUserId: actor.oxyUserId,
      followed,
    });
  } catch (err) {
    logger.error('Federation resolve error:', err);
    return res.status(500).json({ error: 'Resolve failed' });
  }
});

/**
 * POST /federation/follow
 * Follow a remote actor (ActivityPub or atproto), dispatched by protocol.
 */
router.post('/follow', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;
  const userId = resolveUserOr401(req, res);
  if (!userId) return;

  // A user who has turned fediverse sharing off must not send outbound
  // activity of any kind — including a Follow of a remote actor, which would
  // reveal them to the fediverse. Mirrors the `ConnectorRegistry.deliver` seam
  // gate; this route calls `connector.deliver` directly, so it needs its own
  // check.
  if (!(await isFediverseSharingEnabled(userId))) {
    return res.status(403).json({ error: 'Fediverse sharing is disabled' });
  }

  const parsed = actorRefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const connector = await resolveTargetConnector(parsed.data.actorUri);
    if (!connector) return res.status(404).json({ error: 'Unsupported or unknown actor' });

    // Dynamic `import()` (not a static top-level import) defers module
    // resolution past server.ts's own init order — same rationale as
    // `resolveOxyUser` in `connectors/activitypub/constants.ts` and
    // `isFediverseSharingEnabled` in `services/fediverseSharing.ts`, since this
    // route module is pulled in by server.ts before `oxy` is constructed.
    // Unlike a CJS `require()`, a dynamic `import()` is intercepted by `vi.mock`.
    const { oxy } = await import('../../server');
    const user = await oxy.getUserById(userId);
    if (!user?.username) return res.status(404).json({ error: 'User not found' });

    await connector.deliver({
      kind: 'follow.add',
      localOxyUserId: userId,
      localUsername: user.username,
      targetActorUri: parsed.data.actorUri,
    });

    // Read back the actor the connector persisted so the response carries the
    // CANONICAL id the system stores — atproto resolves a handle → DID before
    // writing the follow record, so look up by `uri` (AP actor URI / atproto DID)
    // OR `acct` (the handle a client may have followed by) and return the stored
    // `uri`, the same id `GET /federation/following` returns. Falls back to the
    // raw input when no row was persisted (e.g. a transient resolution failure
    // stored the follow under the raw input).
    // `pending` reflects whether the target manually approves followers (an
    // ActivityPub locked account); atproto actors never do, so this is false.
    const actor = await FederatedActor.findOne({
      $or: [{ uri: parsed.data.actorUri }, { acct: parsed.data.actorUri }],
    })
      .select('uri manuallyApprovesFollowers')
      .lean();
    const canonicalActorUri = actor?.uri ?? parsed.data.actorUri;
    const pending = actor?.manuallyApprovesFollowers === true;

    return res.json({ success: true, pending, actorUri: canonicalActorUri });
  } catch (err) {
    logger.error('Federation follow error:', err);
    return res.status(500).json({ error: 'Follow failed' });
  }
});

/**
 * POST /federation/unfollow
 * Unfollow a remote actor (ActivityPub or atproto), dispatched by protocol.
 */
router.post('/unfollow', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;
  const userId = resolveUserOr401(req, res);
  if (!userId) return;

  // Same gate as `/follow`: even an Undo(Follow) is outbound activity, and the
  // remote server cannot verify it once the actor 404s — no carve-out for
  // unfollow.
  if (!(await isFediverseSharingEnabled(userId))) {
    return res.status(403).json({ error: 'Fediverse sharing is disabled' });
  }

  const parsed = actorRefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const connector = await resolveTargetConnector(parsed.data.actorUri);
    if (!connector) return res.status(404).json({ error: 'Unsupported or unknown actor' });

    // See the matching comment in `POST /follow` above.
    const { oxy } = await import('../../server');
    const user = await oxy.getUserById(userId);
    if (!user?.username) return res.status(404).json({ error: 'User not found' });

    await connector.deliver({
      kind: 'follow.remove',
      localOxyUserId: userId,
      localUsername: user.username,
      targetActorUri: parsed.data.actorUri,
    });

    return res.json({ success: true, actorUri: parsed.data.actorUri });
  } catch (err) {
    logger.error('Federation unfollow error:', err);
    return res.status(500).json({ error: 'Unfollow failed' });
  }
});

/**
 * GET /federation/following
 * List remote accounts the current user follows (any network).
 */
router.get('/following', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;
  const userId = resolveUserOr401(req, res);
  if (!userId) return;

  try {
    const follows = await FederatedFollow.find({
      localUserId: userId,
      direction: 'outbound',
      status: { $in: ['accepted', 'pending'] },
    }).lean();

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = await FederatedActor.find({ uri: { $in: actorUris } }).lean();
    const actorMap = new Map(actors.map((a) => [a.uri, a]));
    const displayNameByUri = await resolveActorDisplayNamesByUri(actors);

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      const handleFallback = actor ? `@${actor.acct}` : f.remoteActorUri;
      return {
        actorUri: f.remoteActorUri,
        network: actor?.protocol ?? f.network ?? 'activitypub',
        handle: actor?.username || 'unknown',
        instance: actor?.domain || 'unknown',
        fullHandle: handleFallback,
        displayName: (actor && displayNameByUri.get(actor.uri)) || handleFallback,
        avatarUrl: actor?.avatarUrl,
        isFollowing: f.status === 'accepted',
        isFollowPending: f.status === 'pending',
      };
    });

    return res.json({ following: results });
  } catch (err) {
    logger.error('Federation following list error:', err);
    return res.status(500).json({ error: 'Failed to fetch following' });
  }
});

/**
 * GET /federation/followers
 * List remote accounts following the current user.
 */
router.get('/followers', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;
  const userId = resolveUserOr401(req, res);
  if (!userId) return;

  try {
    const follows = await FederatedFollow.find({
      localUserId: userId,
      direction: 'inbound',
      status: 'accepted',
    }).lean();

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = await FederatedActor.find({ uri: { $in: actorUris } }).lean();
    const actorMap = new Map(actors.map((a) => [a.uri, a]));
    const displayNameByUri = await resolveActorDisplayNamesByUri(actors);

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      const handleFallback = actor ? `@${actor.acct}` : f.remoteActorUri;
      return {
        actorUri: f.remoteActorUri,
        network: actor?.protocol ?? f.network ?? 'activitypub',
        handle: actor?.username || 'unknown',
        instance: actor?.domain || 'unknown',
        fullHandle: handleFallback,
        displayName: (actor && displayNameByUri.get(actor.uri)) || handleFallback,
        avatarUrl: actor?.avatarUrl,
      };
    });

    return res.json({ followers: results });
  } catch (err) {
    logger.error('Federation followers list error:', err);
    return res.status(500).json({ error: 'Failed to fetch followers' });
  }
});

/**
 * GET /federation/actor/posts?uri=...&cursor=...
 * Get posts from a federated actor stored locally (any network). The empty-state
 * background sync dispatches by the actor's protocol.
 */
router.get('/actor/posts', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;

  const parsed = actorPostsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const actor = await FederatedActor.findOne({ uri: parsed.data.uri }).lean();
    if (!actor) return res.json({ posts: [], hasMore: false });

    const limit = 20;
    // Query by oxyUserId (the canonical user identity in Oxy) for federated posts.
    // Falls back to the activity ID range query if the actor has no Oxy link yet.
    const query: Record<string, unknown> = actor.oxyUserId
      ? { oxyUserId: actor.oxyUserId, federation: { $ne: null }, visibility: PostVisibility.PUBLIC }
      : {
          'federation.activityId': { $gte: actor.uri + '/', $lt: actor.uri + '/\uffff' },
          visibility: PostVisibility.PUBLIC,
        };
    if (parsed.data.cursor) {
      query.createdAt = { $lt: new Date(parsed.data.cursor) };
    }

    let posts = await Post.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    // If no local posts and no cursor (first page), trigger an async backfill
    // dispatched by the actor's network.
    if (posts.length === 0 && !parsed.data.cursor) {
      if (actor.protocol === 'atproto') {
        if (actor.uri) {
          const connector = connectorRegistry.connectorFor(actor.uri);
          if (connector) {
            connector.fetchPosts(actor.uri, { limit }).catch((err) => {
              logger.warn('Background atproto author-feed sync failed:', err);
            });
            return res.json({ posts: [], hasMore: false, syncing: true });
          }
        }
        return res.json({ posts: [], hasMore: false });
      }

      // ActivityPub outbox backfill.
      if (actor.outboxUrl) {
        if (hasUnavailableCurrentOutbox(actor)) {
          return res.json({ posts: [], hasMore: false, syncing: false, syncUnavailable: true });
        }

        // Fire-and-forget: sync in background, return syncing flag to client
        activityPubConnector.syncOutboxPostsDetailed(actor, limit)
          .then(async (result) => {
            if (isPermanentlyUnavailableOutboxReason(result.reason)) {
              await activityPubConnector.markOutboxBackfillUnavailable(actor, result.reason);
            }
          })
          .catch((err) => {
            logger.warn('Background outbox sync failed:', err);
          });
        return res.json({ posts: [], hasMore: false, syncing: true });
      }
    }

    const hasMore = posts.length > limit;
    const sliced = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore ? sliced[sliced.length - 1].createdAt : undefined;

    // Hydrate posts so they render identically to native posts. maxDepth:1 is
    // REQUIRED so federated boosts (empty body, hydrated via boostOf) render.
    const hydrated = await postHydrationService.hydratePosts(sliced, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      publicReferencesOnly: true,
      includeLinkMetadata: false,
    });

    return res.json({ posts: hydrated, hasMore, nextCursor, syncing: false });
  } catch (err) {
    logger.error('Federation actor posts error:', err);
    return res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

export default router;
