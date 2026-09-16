import { createCache } from './cache';
import { getServiceOxyClient } from './oxyHelpers';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { logger } from './logger';

/**
 * Privacy visibility constants
 */
export const ProfileVisibility = {
  PUBLIC: 'public',
  PRIVATE: 'private',
  FOLLOWERS_ONLY: 'followers_only',
} as const;

export type ProfileVisibilityType = typeof ProfileVisibility[keyof typeof ProfileVisibility];

/**
 * Minimal interface for the OxyServices methods we need. Return types are
 * deliberately `unknown` because the Oxy privacy/follow endpoints have several
 * historical response shapes; the `extract*`/`readIdRef` helpers below narrow
 * them defensively at the boundary.
 */
export interface OxyClient {
  getBlockedUsers(): Promise<unknown[]>;
  getRestrictedUsers(): Promise<unknown[]>;
  getUserFollowing(userId: string): Promise<unknown>;
  getUserFollowers(userId: string): Promise<unknown>;
  /**
   * The viewer's OWN graph as ONE ids-only payload (`GET /users/me/graph`):
   * following + mutuals + blocked, each server-bounded. Prefer it over
   * `getUserFollowing` wherever only the ids are needed — that route hydrates a
   * full user DTO per follow, which is a far heavier response for the same
   * answer, and is unbounded where this one is capped server-side.
   *
   * The viewer is derived from the client's own credential, so this is only
   * meaningful on a viewer-scoped client (`createScopedOxyClient`).
   */
  getViewerGraph(): Promise<unknown>;
}

/** Read a string-or-`{_id}` reference, returning the resolved id string when present. */
function readIdRef(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const nested = readProp(value, '_id');
  return typeof nested === 'string' ? nested : undefined;
}

/** Read a property off an unknown object-like value, else undefined. */
function readProp(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** First string-valued property among the candidates, else undefined. */
function firstStringProp(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = readProp(value, key);
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Extract user ID from blocked/restricted user entry
 * Handles different response formats from Oxy API
 */
export function extractUserIdFromBlockedRestricted(entry: unknown): string | undefined {
  if (!entry) return undefined;

  const blockedId = readProp(entry, 'blockedId');
  if (blockedId) {
    return readIdRef(blockedId);
  }
  const restrictedId = readProp(entry, 'restrictedId');
  if (restrictedId) {
    return readIdRef(restrictedId);
  }
  return firstStringProp(entry, ['id', '_id', 'userId', 'targetId']);
}

/**
 * Check if an error is a network error (transient, can be retried)
 */
function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  // Check for network error indicators
  const message = readProp(error, 'message');
  return (
    readProp(error, 'code') === 'NETWORK_ERROR' ||
    readProp(error, 'status') === 0 ||
    (typeof message === 'string' && message.toLowerCase().includes('network'))
  );
}

function getErrorStatus(error: unknown): number | undefined {
  const status =
    readProp(error, 'status') ??
    readProp(error, 'statusCode') ??
    readProp(readProp(error, 'response'), 'status');
  return typeof status === 'number' ? status : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  const rawCode = readProp(error, 'code');
  return typeof rawCode === 'string' && rawCode.length <= 64
    ? rawCode
    : undefined;
}

function isAuthContextError(error: unknown): boolean {
  if (!error) return false;
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) return true;

  const rawCode = readProp(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return true;

  const rawMessage = readProp(error, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';
  return message.includes('authorization header') || message.includes('unauthorized');
}

/**
 * An authenticated viewer privacy read was rejected upstream. Callers must
 * propagate this error: treating it as an empty relation set can disclose
 * blocked/restricted accounts.
 */
export class OxyPrivacyAuthorizationError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly listType: 'blocked' | 'restricted';

  constructor(
    listType: 'blocked' | 'restricted',
    upstreamError: unknown,
  ) {
    super(`Oxy rejected the delegated ${listType} privacy context`);
    this.name = 'OxyPrivacyAuthorizationError';
    this.status = getErrorStatus(upstreamError);
    this.code = getErrorCode(upstreamError);
    this.listType = listType;
  }
}

export function isOxyPrivacyAuthorizationError(
  error: unknown,
): error is OxyPrivacyAuthorizationError {
  return error instanceof OxyPrivacyAuthorizationError;
}

/**
 * Oxy could not provide an authoritative privacy list. Authenticated request
 * paths must fail closed instead of treating an outage or malformed response as
 * proof that the viewer has no blocks/restrictions.
 */
export class OxyPrivacyUnavailableError extends Error {
  readonly listType: 'blocked' | 'restricted';
  readonly status?: number;
  readonly code?: string;
  readonly network: boolean;

  constructor(
    listType: 'blocked' | 'restricted',
    upstreamError: unknown,
  ) {
    super(`Oxy could not resolve the delegated ${listType} privacy context`);
    this.name = 'OxyPrivacyUnavailableError';
    this.listType = listType;
    this.status = getErrorStatus(upstreamError);
    this.code = getErrorCode(upstreamError);
    this.network = isNetworkError(upstreamError);
  }
}

/**
 * Per-viewer cache for the viewer's RELATIONS as Oxy owns them — blocked,
 * restricted, following, followers.
 *
 * WHY: these four lists are read on nearly every authenticated request (the
 * feed reads all four, post detail and hydration's unthreaded fallback the
 * same), each read is an Oxy round trip on the critical path, and Oxy charges
 * them to the viewer's own rate budget. So a reader scrolling spent their budget
 * on their own behalf and then got 429s — and because the blocked/restricted
 * reads fail CLOSED (an empty list would disclose the accounts the viewer hid),
 * what they saw was a 500 on every feed request. The lists themselves had not
 * changed at all.
 *
 * Stale-while-revalidate is what makes fail-closed survivable: an entry younger
 * than {@link VIEWER_RELATIONS_FRESH_MS} is served as-is, an older one is served
 * immediately while ONE refresh runs behind the response, and the entry is
 * RETAINED for {@link VIEWER_RELATIONS_RETENTION_SECONDS} so a refresh that
 * fails keeps answering from the last list Oxy confirmed. Fail-closed still
 * applies where it must: a viewer with no retained entry propagates the error
 * rather than being served "blocks nobody".
 *
 * Staleness is bounded on both ends. Oxy busts its own graph cache on every
 * block/unblock/follow write, and a client that writes one asks Mention to drop
 * these entries ({@link invalidateViewerRelations}, `POST /api/privacy/refresh`),
 * so the freshness window is the backstop for writes nobody told us about — not
 * the normal path by which a new block or follow takes effect.
 *
 * A retained entry is only ever served to the viewer it belongs to, and these
 * lists only ever shape that viewer's own reading, so serving one while Oxy is
 * unreachable cannot disclose anything.
 */
const VIEWER_RELATIONS_FRESH_MS = 30 * 1000;
const VIEWER_RELATIONS_RETENTION_SECONDS = 30 * 60;
const VIEWER_RELATIONS_KEY_PREFIX = 'mtn:viewer:relations:v1:';

/** The four lists, each cached under its own key. */
type ViewerRelation = 'blocked' | 'restricted' | 'following' | 'followers';

const VIEWER_RELATIONS: readonly ViewerRelation[] = ['blocked', 'restricted', 'following', 'followers'];

const viewerRelationsCache = createCache({
  name: 'viewerRelationsCache',
  ttlSeconds: VIEWER_RELATIONS_RETENTION_SECONDS,
  staleAfterMs: VIEWER_RELATIONS_FRESH_MS,
});

function viewerRelationKey(relation: ViewerRelation, viewerId: string): string {
  return `${VIEWER_RELATIONS_KEY_PREFIX}${relation}:${viewerId}`;
}

/**
 * Drop a viewer's cached relations so their next read resolves from Oxy. Called
 * by `POST /api/privacy/refresh` after the client blocks, restricts, follows or
 * unfollows.
 */
export async function invalidateViewerRelations(viewerId: string): Promise<void> {
  await viewerRelationsCache.delete(
    VIEWER_RELATIONS.map((relation) => viewerRelationKey(relation, viewerId)),
  );
}

/**
 * Read one of the viewer's relation lists through the cache above.
 *
 * `viewerId` is what keys it, so a caller that does not know whose list this is
 * (the MCP delegated client resolves its viewer elsewhere) reads straight
 * through to Oxy — uncached, exactly as before.
 *
 * Returns a fresh array per call: callers push federated ids onto what they
 * receive, and a cached array handed out twice would accumulate them.
 */
async function cachedRelation(
  relation: ViewerRelation,
  viewerId: string | undefined,
  read: () => Promise<string[]>,
): Promise<string[]> {
  if (!viewerId) return read();
  const ids = await viewerRelationsCache.getOrCompute(
    viewerRelationKey(relation, viewerId),
    read,
  );
  return [...ids];
}

/**
 * Get user IDs from Oxy privacy API (blocked or restricted users)
 * @param getUserList - Function to fetch the user list from Oxy API
 * @param listType - Type of list for error logging ('blocked' or 'restricted')
 * @returns Array of user IDs
 */
async function readPrivacyList(
  getUserList: () => Promise<unknown[]>,
  listType: 'blocked' | 'restricted'
): Promise<string[]> {
  try {
    const users = await getUserList();
    return users
      .map(extractUserIdFromBlockedRestricted)
      .filter((id): id is string => Boolean(id));
  } catch (error) {
    if (isAuthContextError(error)) {
      logger.warn(`[OxyPrivacy] Rejecting request because ${listType} privacy authorization failed`, {
        status: getErrorStatus(error),
        code: getErrorCode(error),
      });
      throw new OxyPrivacyAuthorizationError(listType, error);
    }

    // Never log the upstream error object: HTTP client errors can contain the
    // request headers (including bearer credentials). The bounded fields below
    // are enough for operations while keeping private requests fail-closed.
    logger.warn(`[OxyPrivacy] Rejecting request because ${listType} privacy resolution failed`, {
      status: getErrorStatus(error),
      code: getErrorCode(error),
      network: isNetworkError(error),
    });
    throw new OxyPrivacyUnavailableError(listType, error);
  }
}

/** {@link readPrivacyList} through the per-viewer relations cache. */
async function getUserIdsFromPrivacyList(
  getUserList: () => Promise<unknown[]>,
  listType: 'blocked' | 'restricted',
  viewerId?: string,
): Promise<string[]> {
  return cachedRelation(listType, viewerId, () => readPrivacyList(getUserList, listType));
}

/**
 * Get blocked user IDs for the authenticated user from Oxy
 * @param client - OxyServices instance (per-request, with auth token set)
 * @param viewerId - whose list this is; keys the per-viewer cache (see
 *   {@link invalidateViewerRelations}). Omitted ⇒ read straight from Oxy.
 */
export async function getBlockedUserIds(client?: OxyClient, viewerId?: string): Promise<string[]> {
  if (!client) {
    throw new OxyPrivacyUnavailableError('blocked', {
      code: 'MISSING_PRIVACY_CLIENT',
    });
  }
  return getUserIdsFromPrivacyList(() => client.getBlockedUsers(), 'blocked', viewerId);
}

/**
 * Get restricted user IDs for the authenticated user from Oxy
 * @param client - OxyServices instance (per-request, with auth token set)
 * @param viewerId - whose list this is; keys the per-viewer cache (see
 *   {@link invalidateViewerRelations}). Omitted ⇒ read straight from Oxy.
 */
export async function getRestrictedUserIds(client?: OxyClient, viewerId?: string): Promise<string[]> {
  if (!client) {
    throw new OxyPrivacyUnavailableError('restricted', {
      code: 'MISSING_PRIVACY_CLIENT',
    });
  }
  return getUserIdsFromPrivacyList(() => client.getRestrictedUsers(), 'restricted', viewerId);
}

/**
 * The viewer's FOLLOWING ids, through the per-viewer relations cache.
 *
 * Soft-fail is the caller's, not this function's: a cold read that Oxy refuses
 * propagates, and every caller already degrades a follow-graph failure to an
 * empty list (a ranking signal, never an access decision — the access checks
 * below deny on failure instead). What the cache adds is that a LATER failure no
 * longer degrades anything: the last list Oxy confirmed is served instead.
 *
 * @param viewerId - whose list this is; keys the cache. Omitted ⇒ uncached.
 */
export async function getFollowingIds(
  viewerId: string | undefined,
  client: OxyClient,
): Promise<string[]> {
  return cachedRelation('following', viewerId, async () =>
    extractFollowingIds(await client.getUserFollowing(viewerId ?? '')));
}

/** The viewer's FOLLOWER ids, through the same cache. See {@link getFollowingIds}. */
export async function getFollowerIds(
  viewerId: string | undefined,
  client: OxyClient,
): Promise<string[]> {
  return cachedRelation('followers', viewerId, async () =>
    extractFollowersIds(await client.getUserFollowers(viewerId ?? '')));
}

/**
 * Extract user IDs from an Oxy following response.
 *
 * Handles every shape the Oxy graph endpoints return: `getUserFollowing`'s
 * hydrated `{ following: User[] }` (and its bare-array variant), and the
 * consolidated viewer graph's ids-only `{ followingIds: string[] }`.
 */
export function extractFollowingIds(followingRes: unknown): string[] {
  const following = readProp(followingRes, 'following') ?? readProp(followingRes, 'followingIds');
  const followingList: unknown[] = Array.isArray(following)
    ? following
    : (Array.isArray(followingRes) ? followingRes : []);

  return followingList
    .map((u): string | undefined =>
      typeof u === 'string'
        ? u
        : (firstStringProp(u, ['id', '_id', 'userId'])
          ?? firstStringProp(readProp(u, 'user'), ['id'])
          ?? firstStringProp(readProp(u, 'profile'), ['id'])
          ?? firstStringProp(u, ['targetId']))
    )
    .filter((id): id is string => Boolean(id));
}

/**
 * Extract user IDs from Oxy followers response
 * Handles various response formats from Oxy API
 */
export function extractFollowersIds(followersRes: unknown): string[] {
  const followers = readProp(followersRes, 'followers');
  const followersList: unknown[] = Array.isArray(followers)
    ? followers
    : (Array.isArray(followersRes) ? followersRes : []);

  return followersList
    .map((entry): string | undefined => {
      if (typeof entry === 'string') {
        return entry;
      }
      return firstStringProp(entry, ['id', '_id', 'userId', 'oxyUserId'])
        ?? firstStringProp(readProp(entry, 'user'), ['id'])
        ?? firstStringProp(readProp(entry, 'profile'), ['id'])
        ?? firstStringProp(entry, ['targetId']);
    })
    .filter((id): id is string => Boolean(id));
}


/**
 * A viewer's block/restrict lists, as threaded into `HydrationOptions` (and
 * `resolveViewerPrivacyAndGraph`'s return) so every caller retyping this shape
 * retypes the SAME one.
 */
export interface ViewerPrivacyContext {
  blockedIds: readonly string[];
  restrictedIds: readonly string[];
}

/** A viewer's follow graph, threaded the same way — see {@link ViewerPrivacyContext}. */
export interface ViewerGraphContext {
  followingIds: string[];
  followerIds: string[];
}

/**
 * Resolve a viewer's block/restrict list AND follow graph in ONE round trip
 * pair, for a caller that hydrates posts without a feed request's context to
 * thread through.
 *
 * `PostHydrationService.buildViewerContext`'s unthreaded fallback resolves
 * these as two SEPARATE sequential round trips — blocked+restricted, THEN
 * following+followers — because each half predates the other's threading
 * support. Nothing in the second half depends on the first, so a caller that
 * needs both (post detail, feed-item detail) can fetch all 4 here concurrently
 * and thread the result in as `viewerPrivacy`/`viewerGraph`, paying for one
 * round trip instead of two.
 *
 * Preserves `buildViewerContext`'s exact fail-open/fail-closed split: blocked/
 * restricted PROPAGATE (`getBlockedUserIds`/`getRestrictedUserIds` throw and
 * must not be swallowed — see `OxyPrivacyUnavailableError`), while a
 * follow-graph fetch failure soft-fails to an empty list, exactly as today.
 *
 * @param viewerId - the authenticated viewer; `undefined` resolves to `undefined`
 * @param client - per-request scoped Oxy client; falls back to the runtime
 *   client for the follow-graph half only, matching `buildViewerContext`
 */
export async function resolveViewerPrivacyAndGraph(
  viewerId: string | undefined,
  client: OxyClient | undefined,
): Promise<{
  viewerPrivacy: ViewerPrivacyContext;
  viewerGraph: ViewerGraphContext;
} | undefined> {
  if (!viewerId) return undefined;

  const oxyForFollows = client || getRuntimeOxyClient();
  const [blockedIds, restrictedIds, followingIds, followerIds] = await Promise.all([
    getBlockedUserIds(client, viewerId),
    getRestrictedUserIds(client, viewerId),
    getFollowingIds(viewerId, oxyForFollows).catch((error: unknown) => {
      logger.warn('[OxyPrivacy] getUserFollowing failed:', error);
      return [];
    }),
    getFollowerIds(viewerId, oxyForFollows).catch((error: unknown) => {
      logger.warn('[OxyPrivacy] getUserFollowers failed:', error);
      return [];
    }),
  ]);

  return {
    viewerPrivacy: { blockedIds, restrictedIds },
    viewerGraph: { followingIds, followerIds },
  };
}

/**
 * Fetch the viewer's following list once and expose it as a Set for batched
 * access checks within a single request path.
 * @param viewerId - The user checking access
 * @param client - Optional per-request OxyServices instance
 * @returns Set of user IDs followed by the viewer
 */
export async function getFollowingIdSet(viewerId: string, client?: OxyClient): Promise<Set<string>> {
  try {
    // A per-request, viewer-scoped `client` is preferred. When absent, fall back
    // to the service-authed Oxy client — NOT the process-wide request-auth
    // client (unauthenticated, reserved for validating incoming request
    // tokens), which would resolve an empty following list and wrongly deny
    // access to private/followers-only content.
    const c = client || getServiceOxyClient();
    return new Set(await getFollowingIds(viewerId, c));
  } catch (error) {
    logger.error('Error fetching following list for access check:', error);
    return new Set(); // On error, deny access for privacy
  }
}

/**
 * Check if a user is following another user
 * @param viewerId - The user checking access
 * @param targetUserId - The user being checked
 * @param client - Optional per-request OxyServices instance
 * @returns true if viewer follows target, false otherwise
 */
export async function checkFollowAccess(viewerId: string, targetUserId: string, client?: OxyClient): Promise<boolean> {
  const followingIds = await getFollowingIdSet(viewerId, client);
  return followingIds.has(targetUserId);
}

/**
 * Check if a profile requires access check (private or followers_only)
 */
export function requiresAccessCheck(profileVisibility: string | undefined): boolean {
  return profileVisibility === ProfileVisibility.PRIVATE ||
         profileVisibility === ProfileVisibility.FOLLOWERS_ONLY;
}

/**
 * Whether a viewer may read a profile's DESIGN surface — banner, appearance,
 * customization, pinned profile media.
 *
 * This is the ONE access rule behind every profile-design response. Both
 * `GET /profile/design/:userId` and `GET /profile/settings/:userId` serve that
 * same DTO, so both must call this: when only the design route gated it, a
 * private profile's banner and appearance stayed readable through the settings
 * route by any authenticated account.
 *
 * The owner always has access; a public profile is open to everyone, anonymous
 * viewers included; a private or followers-only profile requires an
 * authenticated viewer who follows the owner.
 *
 * @param targetUserId - The profile being read
 * @param viewerUserId - The viewer, or undefined when unauthenticated
 * @param profileVisibility - The target's `privacy.profileVisibility`
 * @param client - Optional per-request OxyServices instance
 */
export async function canViewProfileDesign(
  targetUserId: string,
  viewerUserId: string | undefined,
  profileVisibility: string | undefined,
  client?: OxyClient,
): Promise<boolean> {
  if (viewerUserId && viewerUserId === targetUserId) return true;
  if (!requiresAccessCheck(profileVisibility)) return true;
  if (!viewerUserId) return false;
  return checkFollowAccess(viewerUserId, targetUserId, client);
}
