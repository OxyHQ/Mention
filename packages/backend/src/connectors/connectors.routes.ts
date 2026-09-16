import { resolveAvatarUrl } from '../utils/mediaResolver';
import { Router, Response } from 'express';
import { z } from 'zod';
import { getRequiredOxyUserId, type OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import type { User as OxyUser } from '@oxy.so/core';
import { notCollapsedCrosspostSql } from '../utils/feedQueryBuilder';
import { getErrorStatus } from '@oxy.so/core';
import {
  PostVisibility,
  type FederationBlocksResponse,
  type PostContent,
} from '@mention/shared-types';
import { logger } from '../utils/logger';
import { activityPubConnector, isPermanentlyUnavailableOutboxReason } from './activitypub/ActivityPubConnector';
import {
  findActorByUri,
  findActorByUriOrAcct,
  findActorsByUris,
} from '../db/federation/actorRepository';
import {
  existsFollow,
  findFollows,
} from '../db/federation/followRepository';
import { and, eq, isNotNull, lt, type SQL } from 'drizzle-orm';
import { posts as postsTable } from '../db/schema/posts';
import { CHRONO_DESC, findPostRecords } from '../db/posts/postRepository';
import { FEDERATION_BLOCKS, FEDERATION_ENABLED } from './activitypub/constants';
import { ATPROTO_ENABLED, isDid, isAtUri, isAtprotoHandle } from './atproto/constants';
import { activityIdUnderActor, normalizeFederatedAcct } from './activitypub/helpers';
import { resolveOxyIdentity } from './oxyIdentity';
import { isAbsoluteHttpUrl } from './shared/url';
import { connectorRegistry } from './index';
import { classifyQuery } from './resolve';
import type { NetworkConnector } from '@oxy.so/federation';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient, getServiceOxyClient } from '../utils/oxyHelpers';
import { apiRateLimiter } from '../middleware/rateLimiter';
import { isFediverseSharingEnabled, invalidateFediverseSharing } from '../services/fediverseSharing';
import { invalidateWebfingerCache } from './activitypub/webfingerCache';
import { enqueueSharingCleanup } from '../queue/producers';
import { runSharingCleanup } from './activitypub/sharingCleanup.service';

/**
 * Cross-network connector API (mounted at `/federation`, URL kept stable for the
 * frontend). Generalized from the ActivityPub-only `federation.api.routes`:
 * follow / unfollow now dispatch to the connector that owns the target's
 * protocol, `/resolve` performs unified cross-network handle resolution, and the
 * `actor/posts` empty-state sync dispatches by `federated_actors.protocol`. The
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
 * A STORED `federated_actors.uri` is always canonical: an ActivityPub actor URI
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
 * atproto handle / DID / AT-URI), a bare local username, or a pasted profile URL.
 * Rejecting everything else (whitespace, path/query chars on a bare handle) keeps
 * junk out of the downstream network dispatch (XRPC / WebFinger /
 * `https://<handle>/...` / DNS).
 *
 * A URL is admitted here as a SHAPE and nowhere near that dispatch: the handler
 * routes one down its own lane, which derives bridge accts from our committed
 * policy and 404s a URL it does not recognise. So a pasted URL is never fetched,
 * never classified as a handle, and never reaches a connector — the property this
 * refine used to hold by rejecting the whole shape now lives one layer down,
 * where it can state which hosts are allowed rather than only that none are.
 */
function isResolvableQuery(value: string): boolean {
  return (
    Boolean(normalizeFederatedAcct(value))
    || isAtprotoHandle(value)
    || isDid(value)
    || isAtUri(value)
    || isAbsoluteHttpUrl(value)
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
 * Identity resolution is owned entirely by `@oxy.so/core/server`
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
 * `federated_actors.protocol` (authoritative once an actor is known), falling back
 * to shape-based `matches` (an http URI → ActivityPub, a DID → atproto).
 */
async function resolveTargetConnector(target: string): Promise<NetworkConnector<PostContent> | undefined> {
  const stored = await findActorByUri(target);
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

/** Batch Oxy profiles by source URI, including historical IDs redirected to the same person. */
async function resolveActorProfilesByUri(
  actors: Array<{ uri: string; oxyUserId?: string }>,
): Promise<Map<string, OxyUser>> {
  const byUri = new Map<string, OxyUser>();
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

  const userByOxyId = new Map<string, OxyUser>();
  for (const user of users) {
    if (user.id) userByOxyId.set(user.id, user);
    const aliases = 'redirectedUserIds' in user ? user.redirectedUserIds : undefined;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === 'string') userByOxyId.set(alias, user);
      }
    }
  }

  for (const actor of actors) {
    if (!actor.oxyUserId) continue;
    const user = userByOxyId.get(actor.oxyUserId);
    if (user) byUri.set(actor.uri, user);
  }
  return byUri;
}

// --- Routes ---
// Note: Local profile search/lookup is handled by OxyHQServices
// (/profiles/search, /profiles/resolve). These routes handle cross-network
// federation operations (resolve, follows, posts).

/**
 * GET /federation/blocked-domains
 *
 * The instances Mention refuses to federate with, and why — public, because
 * moderation policy is a statement to the outside world and every instance whose
 * published blocklist we read makes the same one.
 *
 * Served from {@link FEDERATION_BLOCKS}, the SAME array the federation policy
 * derives its enforced set from, so what this returns and what the server
 * actually does cannot drift apart. Our own domains and the Oxy identity apex are
 * rejected by that policy too but are not moderation decisions, and are not in
 * this list — see `activitypub/federationBlockPolicy`.
 *
 * No auth: an unauthenticated reader is the audience.
 */
router.get('/blocked-domains', (_req: AuthRequest, res: Response) => {
  const body: FederationBlocksResponse = { blocks: [...FEDERATION_BLOCKS] };
  return res.json(body);
});

/** Resolve public identifiers through Oxy, then import the returned protocol source. */
router.get('/resolve', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;

  const parsed = resolveQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const query = parsed.data.handle;
  const isPastedUrl = isAbsoluteHttpUrl(query);
  // NOT AN ERROR STATUS, AND THE REASON IS WHAT THIS ENDPOINT IS FOR.
  //
  // This is a search-as-you-type probe: the caller fires it on a debounced
  // keystroke and merges any hit into the people results as one extra row. So
  // "no such actor" is not an exceptional outcome, it is the MAJORITY outcome —
  // most queries name nobody on another network, and the sole consumer already
  // mapped the 404 straight to `null` without reading it.
  //
  // Representing the common case as an error misreports it everywhere it is
  // counted: a red line in the browser console for an ordinary search, a 404
  // rate in monitoring that reads as breakage, and a log full of failures that
  // are not. Same reasoning that made an exhausted `maxTimeMS` a 503 rather than
  // a 500 — the status has to describe what actually happened.
  //
  // A genuinely malformed request is still a 400, and an upstream failure is
  // still a 500: `{ actor: null }` means "asked, answered, nobody", never
  // "something went wrong and we swallowed it".
  if (!isPastedUrl && classifyQuery(query) === 'local') {
    return res.json({ actor: null });
  }

  try {
    const resolved = await resolveOxyIdentity({ handle: query });
    const source = resolved.externalIdentity;
    const connector = connectorRegistry.connectorFor(source.actorUri);
    if (!connector?.enabled || connector.id !== source.protocol) return res.json({ actor: null });
    const actor = await connector.fetchProfile(source.actorUri);
    if (!actor || actor.externalId !== source.actorUri
      || (actor.oxyUserId && actor.oxyUserId !== resolved.user.id)) return res.json({ actor: null });

    // Follow state for the (optional) viewer — keyed on the actor's protocol id.
    let followed = false;
    const viewerId = req.user?.id;
    if (viewerId) {
      followed = await existsFollow({
        localUserId: viewerId,
        remoteActorUri: actor.externalId,
        direction: 'outbound',
        statuses: ['accepted', 'pending'],
      });
    }

    return res.json({
      actor: {
        network: source.protocol,
        externalId: actor.externalId,
        // The IDENTITY, never the protocol address. `handle` is the account this
        // row IS — the same `local@domain` the ingest just stored in Oxy — while
        // `externalId` stays the protocol id the follow is addressed to. The two
        // differ for exactly the actors this lane exists to reach: a bridged actor's
        // protocol acct names the BRIDGE (`elonmusk@bird.makeup`), so returning it
        // renders a reader the hostname a copy happened to arrive through instead
        // of the account that wrote the posts, and — because the client dedupes the
        // resolved actor against the people results BY HANDLE — leaves it sitting
        // next to the Oxy row for the same person as a visible twin. An atproto
        // actor's differs too (`alice.bsky.social` addresses, `alice@bsky.social`
        // identifies), and had the same duplicate-row consequence.
        handle: resolved.user.username,
        displayName: resolved.user.name?.displayName,
        avatarUrl: resolveAvatarUrl(resolved.user.avatar),
        oxyUserId: resolved.user.id,
        followed,
      },
    });
  } catch (err) {
    if (getErrorStatus(err) === 404) return res.json({ actor: null });
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

    // Service-authed Oxy client — the process-wide request-auth client is
    // unauthenticated and reserved for validating incoming request tokens
    // (`oxy.auth()`), so resolving a user on it returns nothing.
    const user = await getServiceOxyClient().getUserById(userId);
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
    const actor = await findActorByUriOrAcct(parsed.data.actorUri);
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

    const user = await getServiceOxyClient().getUserById(userId);
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
 * POST /federation/sharing-changed
 *
 * Session-authenticated notification that the caller's `fediverseSharing` flag
 * may have just changed in Oxy (no body — the route never trusts a
 * client-supplied value). Evicts every cache keyed on the OLD value, re-reads
 * the flag from Oxy, and — only on a transition to OFF — queues the
 * Delete(actor) + follower-teardown cleanup (`runSharingCleanup`).
 *
 * Two independent caches key on this flag and MUST both be evicted on every
 * call, regardless of the new value:
 *  - `isFediverseSharingEnabled`'s own Redis cache (`invalidateFediverseSharing`).
 *  - The WebFinger JRD cache (`invalidateWebfingerCache`) — `GET
 *    /.well-known/webfinger` serves a cache hit BEFORE its sharing gate runs,
 *    so a stale entry would keep a toggled user (un)discoverable for up to 1h.
 */
router.post('/sharing-changed', async (req: AuthRequest, res: Response) => {
  if (!requireAnyConnector(res)) return;
  const userId = resolveUserOr401(req, res);
  if (!userId) return;

  try {
    await invalidateFediverseSharing(userId);
    // Fresh read from Oxy, AFTER invalidating — never trust the client's view
    // of the flag.
    const enabled = await isFediverseSharingEnabled(userId);

    const user = await getServiceOxyClient().getUserById(userId);

    let cleanupQueued = false;
    if (user?.username) {
      await invalidateWebfingerCache(user.username);

      if (!enabled) {
        cleanupQueued = true;
        const nonce = String(Date.now());
        const queued = await enqueueSharingCleanup({ oxyUserId: userId, username: user.username, nonce });
        if (!queued) {
          runSharingCleanup(userId, user.username).catch((err) => {
            logger.error('sharing cleanup inline failed:', err);
          });
        }
      }
    }

    return res.status(202).json({ status: 'ok', cleanupQueued });
  } catch (err) {
    logger.error('sharing-changed error:', err);
    return res.status(500).json({ error: 'Failed to apply sharing change' });
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
    const follows = await findFollows({
      localUserId: userId,
      direction: 'outbound',
      statuses: ['accepted', 'pending'],
    });

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = await findActorsByUris(actorUris);
    const actorMap = new Map(actors.map((a) => [a.uri, a]));
    const profilesByUri = await resolveActorProfilesByUri(actors);

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      const profile = actor ? profilesByUri.get(actor.uri) : undefined;
      const username = profile?.username ?? '';
      const separator = username.lastIndexOf('@');
      return {
        actorUri: f.remoteActorUri,
        network: actor?.protocol ?? f.network ?? 'activitypub',
        handle: separator > 0 ? username.slice(0, separator) : username,
        instance: separator > 0 ? username.slice(separator + 1) : '',
        fullHandle: username ? `@${username}` : '',
        displayName: profile?.name?.displayName || (username ? `@${username}` : 'Unavailable profile'),
        avatarUrl: resolveAvatarUrl(profile?.avatar),
        oxyUserId: profile?.id,
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
    const follows = await findFollows({
      localUserId: userId,
      direction: 'inbound',
      statuses: ['accepted'],
    });

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = await findActorsByUris(actorUris);
    const actorMap = new Map(actors.map((a) => [a.uri, a]));
    const profilesByUri = await resolveActorProfilesByUri(actors);

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      const profile = actor ? profilesByUri.get(actor.uri) : undefined;
      const username = profile?.username ?? '';
      const separator = username.lastIndexOf('@');
      return {
        actorUri: f.remoteActorUri,
        network: actor?.protocol ?? f.network ?? 'activitypub',
        handle: separator > 0 ? username.slice(0, separator) : username,
        instance: separator > 0 ? username.slice(separator + 1) : '',
        fullHandle: username ? `@${username}` : '',
        displayName: profile?.name?.displayName || (username ? `@${username}` : 'Unavailable profile'),
        avatarUrl: resolveAvatarUrl(profile?.avatar),
        oxyUserId: profile?.id,
      };
    });

    return res.json({ followers: results });
  } catch (err) {
    logger.error('Federation followers list error:', err);
    return res.status(500).json({ error: 'Failed to fetch followers' });
  }
});

/**
 * Which stored posts belong to one remote actor's page.
 *
 * Exported, and for the same reason as `buildPostsByHashtagFilter` /
 * `buildPostsByTopicFilter`: the scope IS the whole decision this route makes
 * about which posts exist for an actor, and naming it lets that be asserted
 * against rows rather than against the page a stubbed route happened to build.
 *
 * Two branches, because an actor Oxy has adopted and one it has not are reached
 * by different keys:
 *
 *  - With an Oxy link, `is not null`, NOT `<> null`: Mongo's `$ne: null` also
 *    matched a MISSING `federation` subdocument, while SQL's `<>` against NULL
 *    is NULL and matches nothing — the literal translation would return an empty
 *    author feed for every actor that HAS an Oxy link, which is all of them.
 *  - Without one, a PREFIX rather than a range — see `activityIdUnderActor`. The
 *    range this replaces matched nothing under a linguistic collation, so an
 *    actor with no Oxy link served an empty feed however many posts it had.
 *
 * The collapsed half of a Meta cross-post is excluded from the FIRST branch
 * only, and the asymmetry is real rather than an oversight: one Oxy person can
 * own both source actors of a proven Instagram ↔ Threads pair, so that branch is
 * exactly where both halves can reach one page. The prefix branch is scoped to a
 * single actor URI, where at most one half can match at all.
 */
export function buildActorPostsScopeSql(
  actor: { uri: string; oxyUserId?: string | null },
): SQL {
  const reachedBy = actor.oxyUserId
    ? [
      eq(postsTable.oxyUserId, actor.oxyUserId),
      isNotNull(postsTable.federationActivityId),
      notCollapsedCrosspostSql(),
    ]
    : [activityIdUnderActor(actor.uri)];
  return and(eq(postsTable.visibility, PostVisibility.PUBLIC), ...reachedBy) as SQL;
}

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
    const actor = await findActorByUri(parsed.data.uri);
    if (!actor) return res.json({ posts: [], hasMore: false });

    const limit = 20;
    // `and` drops an `undefined` operand, so the cursor needs no array to live in.
    const cursor = parsed.data.cursor
      ? lt(postsTable.createdAt, new Date(parsed.data.cursor))
      : undefined;

    let posts = await findPostRecords(and(buildActorPostsScopeSql(actor), cursor), {
      orderBy: CHRONO_DESC,
      limit: limit + 1,
    });

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
