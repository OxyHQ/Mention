import { getErrorStatus, normalizeUserIdentityOrNull, type User as OxyUser } from '@oxy.so/core';
import { normalizeFederatedAcct } from '@mention/shared-types/federation';
import { stripHandlePrefix } from '@mention/shared-types/handle';
import { isRefusedFederatedProfile } from '../../connectors/profileSourcePolicy';
import { createCache } from '../../utils/cache';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { isAccountErased } from './accountErasure/erasedAccounts';

/**
 * A profile by handle, local or federated, resolved by Mention's backend.
 *
 * WHY THIS EXISTS. The web app used to ask Oxy directly from the browser
 * (`oxyServices.users.resolveHandle` → `GET api.oxy.so/profiles/resolve`) for
 * every federated profile page and hover card. That endpoint runs WebFinger /
 * ActivityPub / atproto discovery and upserts the remote actor: a browser was
 * starting Oxy's internal federation work, with no Mention policy in between.
 * Resolution is Mention's to do, server-to-server, and the browser only ever
 * asks Mention.
 *
 * HOW. Oxy is asked once per handle as Mention's own registered workload (its
 * service token naming no account, ADR 0066: a service acting as itself reaches
 * only public data, which this is). The answer is the anonymous public profile,
 * the same for every viewer, so it is cached here and shared: a popular remote
 * profile costs one discovery, not one per reader. Mention's own rules then run
 * on it: an instance Mention refuses to federate with and an account Oxy told
 * Mention was erased both answer as "no such profile".
 *
 * The viewer-relative `relationship` (`isFollowing` / `followsYou`) is never
 * cached here: see {@link viewerRelationship}.
 *
 * NO EXISTENCE ORACLE. Every way of not having a profile to show (unknown,
 * malformed, archived, restricted, erased, on a refused instance) is the same
 * `null`. Nothing distinguishes an unknown local account from any other miss.
 */

/** How long a resolved public profile is served without asking Oxy again. */
const PROFILE_FRESH_MS = 60_000;
/**
 * How long one is kept at all. Past {@link PROFILE_FRESH_MS} it is still served
 * at once while one background read refreshes it (stale-while-revalidate), so a
 * profile edit is visible within a minute and a reader never waits on Oxy for a
 * profile someone opened in the last five.
 */
const PROFILE_TTL_SECONDS = 5 * 60;
/**
 * A miss is kept only long enough to absorb a burst (a shared link opened by
 * many readers at once), never long enough to keep a just-discovered account
 * "not found": the next look a few seconds later asks Oxy again.
 */
const MISS_TTL_SECONDS = 10;
/** Discovery can be slow (remote WebFinger); bounded below the web client's 15 s timeout. */
const OXY_RESOLVE_DEADLINE_MS = 12_000;

/** Bumped on any change to the cached value's shape. */
const CACHE_PREFIX = 'profile-by-handle:v1:';

const profileByHandleCache = createCache({
  name: 'ProfileByHandleCache',
  ttlSeconds: PROFILE_TTL_SECONDS,
  staleAfterMs: PROFILE_FRESH_MS,
});

/** A bare local Oxy username, as `connectors/localFollow` accepts one. */
const LOCAL_USERNAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;
/** One `user@host` pair, nothing else: no second `@`, no path, query or whitespace. */
const ACCT_RE = /^[^\s/?#@]+@[^\s/?#@]+$/;
/** Longest acct a profile route can carry (local part plus a DNS name). */
const MAX_HANDLE_LENGTH = 320;

/**
 * The one spelling of a handle this resolves: a federated `user@host` acct
 * lower-cased (`normalizeFederatedAcct`, the spelling the web app keys by), or a
 * bare local username. `undefined` for anything that is neither.
 */
export function profileHandleKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HANDLE_LENGTH) return undefined;
  const acct = normalizeFederatedAcct(trimmed);
  if (acct) return ACCT_RE.test(acct) ? acct : undefined;
  const local = stripHandlePrefix(trimmed);
  return LOCAL_USERNAME_RE.test(local) ? local.toLowerCase() : undefined;
}

/**
 * Oxy's public profile for `handle`, discovering a remote account Oxy does not
 * know yet. `null` when Oxy has none to show (its `null`, a 404, or a 400 for a
 * handle it will not try to discover). Any other failure throws, so an outage is
 * never cached or shown as "not found".
 */
async function readPublicProfile(handle: string): Promise<OxyUser | null> {
  try {
    const answer = await getServiceOxyClient().serviceRequest<OxyUser | null>(
      'GET',
      '/profiles/resolve',
      { handle },
      { cache: false, deadline: OXY_RESOLVE_DEADLINE_MS },
    );
    return normalizeUserIdentityOrNull(answer as OxyUser | null);
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 400 || status === 404) return null;
    throw error;
  }
}

/**
 * Oxy's answer for a normalized handle, through the shared cache. Concurrent
 * readers of one handle in this process share one Oxy read. Rejects when Oxy
 * could not answer; nothing is cached then.
 *
 * Only Oxy's answer is cached. Mention's own rules run on every request in
 * {@link getPublicProfileByHandle}, so an erasure or a newly refused instance
 * applies on the next look, not when an entry expires.
 */
function cachedOxyProfile(handle: string): Promise<OxyUser | null> {
  return profileByHandleCache.getOrCompute(
    `${CACHE_PREFIX}${handle}`,
    async () => {
      const profile = await readPublicProfile(handle);
      if (!profile?.id) return null;
      // Oxy's anonymous answer carries no `relationship`; strip one anyway so a
      // shared entry can never hand one viewer another's.
      const { relationship: _relationship, ...shared } = profile;
      return shared as OxyUser;
    },
    { ttlSecondsFor: (profile) => (profile ? PROFILE_TTL_SECONDS : MISS_TTL_SECONDS) },
  );
}

/**
 * The public profile Mention shows for a normalized handle (see
 * {@link profileHandleKey}), or `null`: Oxy has none, it is on an instance
 * Mention refuses, or Oxy told Mention the account was erased. Rejects when Oxy
 * could not answer, so the caller reports an outage rather than "not found".
 */
export async function getPublicProfileByHandle(handle: string): Promise<OxyUser | null> {
  const profile = await cachedOxyProfile(handle);
  if (!profile?.id || isRefusedFederatedProfile(profile)) return null;
  if (await isAccountErased(profile.id)) return null;
  return profile;
}

/** The narrow per-viewer Oxy read {@link viewerRelationship} needs. */
export interface ViewerProfileReader {
  users: { get(userId: string, options?: { cache?: boolean }): Promise<OxyUser> };
}

/**
 * The viewer's `relationship` to a profile, from Oxy's own single-profile read
 * (`GET /users/:id`), which computes it across linked aliases in the same
 * handler. Asked with the viewer's own verified Oxy session (`callerOxyUser`),
 * the same lane as every other read Mention makes for the person in front of it,
 * and never cached: a follow or unfollow must show on the next look.
 *
 * Best-effort: `undefined` ("unknown") when there is no person session or the
 * read fails. The page then reads the follow store instead, exactly as it does
 * for any profile Oxy returned without one.
 */
export async function viewerRelationship(
  reader: ViewerProfileReader | undefined,
  viewerId: string | undefined,
  profileId: string,
): Promise<OxyUser['relationship'] | undefined> {
  if (!reader || !viewerId || viewerId === profileId) return undefined;
  try {
    const viewed = await reader.users.get(profileId, { cache: false });
    return viewed?.relationship ?? undefined;
  } catch (error) {
    logger.debug('[ProfileByHandle] viewer relationship unavailable', {
      status: getErrorStatus(error),
    });
    return undefined;
  }
}
