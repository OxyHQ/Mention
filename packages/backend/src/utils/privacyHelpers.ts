import { getServiceOxyClient } from './oxyHelpers';
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
 * Get user IDs from Oxy privacy API (blocked or restricted users)
 * @param getUserList - Function to fetch the user list from Oxy API
 * @param listType - Type of list for error logging ('blocked' or 'restricted')
 * @returns Array of user IDs
 */
async function getUserIdsFromPrivacyList(
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

/**
 * Get blocked user IDs for the authenticated user from Oxy
 * @param client - OxyServices instance (per-request, with auth token set)
 */
export async function getBlockedUserIds(client?: OxyClient): Promise<string[]> {
  if (!client) {
    throw new OxyPrivacyUnavailableError('blocked', {
      code: 'MISSING_PRIVACY_CLIENT',
    });
  }
  return getUserIdsFromPrivacyList(() => client.getBlockedUsers(), 'blocked');
}

/**
 * Get restricted user IDs for the authenticated user from Oxy
 * @param client - OxyServices instance (per-request, with auth token set)
 */
export async function getRestrictedUserIds(client?: OxyClient): Promise<string[]> {
  if (!client) {
    throw new OxyPrivacyUnavailableError('restricted', {
      code: 'MISSING_PRIVACY_CLIENT',
    });
  }
  return getUserIdsFromPrivacyList(() => client.getRestrictedUsers(), 'restricted');
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
    const followingRes = await c.getUserFollowing(viewerId);
    return new Set(extractFollowingIds(followingRes));
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
