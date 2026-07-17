import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';
import { logger } from '../../utils/logger';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import { resolveOxyExternalUser } from '../identity';
import type { NormalizedExternalActor } from '../types';
import { xrpcGet } from './xrpcClient';
import { BSKY_NETWORK_DOMAIN, PUBLIC_APPVIEW } from './constants';

/**
 * Maps an `app.bsky.actor.getProfile` response into a network-neutral actor,
 * upserts the backing `FederatedActor` row (`protocol:'atproto'`), and mints /
 * stamps the Oxy user it maps to through the shared identity bridge.
 */

/** The subset of `app.bsky.actor.defs#profileViewDetailed` this connector reads. */
export interface AtprotoProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  banner?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
}

/**
 * Split an atproto handle (a DNS name) into its display username, instance
 * domain, and the canonical `local@domain` username Oxy stores it under.
 *
 * For the atproto connector the instance domain is ALWAYS the Bluesky network
 * domain (`bsky.social`): a Bluesky handle is a whole DNS name that identifies the
 * account, not a `local@host` address, and the account lives on the Bluesky
 * network regardless of how many labels the handle has or whether it is a custom
 * domain.
 *
 * The username is the DEFAULT-Bluesky-handle base: because the instance domain is
 * already `bsky.social`, the `.bsky.social` suffix on a default handle is
 * redundant, so it is stripped from the username to avoid the doubled
 * `@skylee1.bsky.social@bsky.social`. A CUSTOM domain handle is not a
 * `.bsky.social` handle, so its whole handle stays the username:
 *   - `skylee1.bsky.social` → username `skylee1`,       instance `bsky.social`.
 *   - `gothamist.com`       → username `gothamist.com`,  instance `bsky.social`.
 *   - `mayor.nyc.gov`       → username `mayor.nyc.gov`,  instance `bsky.social`.
 *   - `jay.bsky.team`       → username `jay.bsky.team`,  instance `bsky.social`
 *                             (`.bsky.team` is NOT `.bsky.social` — kept).
 *
 * Deriving the instance from the handle's own parent domain was the ORIGINAL bug:
 * a multi-label custom domain (`mayor.nyc.gov`) produced the bogus instance
 * `nyc.gov`, rendering `@mayor.nyc.gov@nyc.gov` instead of the correct
 * `@mayor.nyc.gov@bsky.social`. That is now fixed (instance is always
 * `bsky.social`); the `.bsky.social` strip is the follow-up that also drops the
 * redundant suffix on default handles.
 *
 * The federated Oxy username is `<username>@bsky.social`
 * (`skylee1@bsky.social`, `mayor.nyc.gov@bsky.social`) — the exact form oxy-api's
 * `PUT /users/resolve` binds (username domain must equal `domain`).
 *
 * Exported so the re-derive repair scripts can DETECT a stored actor whose
 * re-derived `federatedUsername` no longer equals `${stored.username}@${stored.domain}`
 * without re-fetching the profile — a stored `.bsky.social` actor keeps the same
 * `domain` (`bsky.social`) but its `username` changes, so the scripts must compare
 * the full `local@domain`, not the domain alone.
 */
export function splitHandle(handle: string): { username: string; domain: string; federatedUsername: string } {
  // For a default Bluesky handle (`<username>.bsky.social`) the `.bsky.social`
  // suffix is redundant once the instance domain is already `bsky.social`, so the
  // username is the handle with that suffix stripped. A custom domain handle is not
  // a `.bsky.social` handle, so its whole handle stays the username. Guard the
  // degenerate `handle === 'bsky.social'` (stripping would leave an empty username)
  // by keeping the full handle in that case.
  const suffix = `.${BSKY_NETWORK_DOMAIN}`;
  const username =
    handle !== BSKY_NETWORK_DOMAIN && handle.endsWith(suffix) ? handle.slice(0, -suffix.length) : handle;
  return {
    username,
    domain: BSKY_NETWORK_DOMAIN,
    federatedUsername: `${username}@${BSKY_NETWORK_DOMAIN}`,
  };
}

/** Map a getProfile response to the network-neutral actor shape (pure). */
export function mapProfileToNormalizedActor(profile: AtprotoProfileView): NormalizedExternalActor | null {
  const did = typeof profile.did === 'string' ? profile.did : '';
  const handle = typeof profile.handle === 'string' ? profile.handle : '';
  if (!did || !handle) return null;

  const { domain, federatedUsername } = splitHandle(handle);
  // Bluesky text is third-party text: it carries whatever whitespace the author
  // (or their client) typed, and our clients render it faithfully
  // (`white-space: pre-wrap`). The display name is ONE LINE — a newline in it is
  // never meaningful — while the bio is a BODY whose paragraphs must survive.
  const displayName = typeof profile.displayName === 'string' ? normalizeInlineText(profile.displayName) : '';
  const bio = typeof profile.description === 'string' ? normalizeMultilineText(profile.description) : '';
  return {
    network: 'atproto',
    externalId: did,
    handle,
    // A DID carries no host and a handle is a whole DNS name, so an atproto actor's
    // Oxy identity is keyed on the Bluesky network domain (`bsky.social`). These are
    // what the shared identity bridge sends to oxy-api.
    federatedUsername,
    instanceDomain: domain,
    displayName: displayName || undefined,
    avatarUrl: profile.avatar || undefined,
    bannerUrl: profile.banner || undefined,
    bio: bio || undefined,
    followersCount: typeof profile.followersCount === 'number' ? profile.followersCount : undefined,
    followingCount: typeof profile.followsCount === 'number' ? profile.followsCount : undefined,
    postsCount: typeof profile.postsCount === 'number' ? profile.postsCount : undefined,
  };
}

/**
 * Upsert the `FederatedActor` row for a normalized atproto actor and resolve its
 * Oxy user. Returns the actor with `oxyUserId` populated when Oxy resolved it.
 *
 * Fails soft: if `resolveOxyExternalUser` returns null (e.g. oxy-api does not yet
 * accept a `did:` `actorUri`), the actor row is still upserted but `oxyUserId`
 * stays undefined — callers MUST NOT import posts for an unresolved author (no
 * orphan posts), exactly like the ActivityPub no-orphan invariant.
 */
export async function upsertAtprotoActor(actor: NormalizedExternalActor): Promise<NormalizedExternalActor> {
  const did = actor.externalId;
  const { username, domain } = splitHandle(actor.handle);

  let fedActor: IFederatedActor | null = null;
  try {
    fedActor = await FederatedActor.findOneAndUpdate(
      { uri: did },
      {
        $set: {
          protocol: 'atproto',
          uri: did,
          username,
          domain,
          acct: actor.handle,
          // Normalized again (idempotent) rather than trusted: this function is
          // exported and does not require its caller to have gone through
          // `mapProfileToNormalizedActor`.
          summary: normalizeMultilineText(actor.bio ?? ''),
          avatarUrl: actor.avatarUrl,
          headerUrl: actor.bannerUrl,
          type: 'Person',
          followersCount: actor.followersCount ?? 0,
          followingCount: actor.followingCount ?? 0,
          postsCount: actor.postsCount ?? 0,
          lastFetchedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after', lean: true },
    ) as IFederatedActor | null;
  } catch (err) {
    // A rare unique-key collision (a handle reassigned across DIDs) must not
    // abort discovery — log and continue with no stamped row.
    logger.warn(`[atproto] failed to upsert FederatedActor for ${did}`, err);
  }

  const existingOxyId = fedActor?.oxyUserId ?? undefined;
  const oxyId = await resolveOxyExternalUser({ ...actor, oxyUserId: existingOxyId });
  if (!oxyId) {
    // Hard runtime dependency: oxy-api `PUT /users/resolve` must accept a `did:`
    // actorUri. Until it does this returns null — fail soft (no throw, no orphan).
    logger.warn(`[atproto] Oxy user unresolved for ${did}; importing skipped until oxy-api accepts did: actorUri`);
    return { ...actor, oxyUserId: undefined };
  }

  if (fedActor && fedActor.oxyUserId !== oxyId) {
    await FederatedActor.updateOne({ _id: fedActor._id }, { $set: { oxyUserId: oxyId } });
  }
  return { ...actor, oxyUserId: oxyId };
}

/**
 * Fetch a Bluesky profile (`app.bsky.actor.getProfile`), normalize it, upsert the
 * `FederatedActor`, and resolve its Oxy user. `actor` may be a handle or a DID.
 * Returns null when the profile cannot be fetched / mapped.
 */
export async function fetchAndUpsertAtprotoProfile(actor: string): Promise<NormalizedExternalActor | null> {
  let profile: AtprotoProfileView;
  try {
    profile = await xrpcGet<AtprotoProfileView>(PUBLIC_APPVIEW, 'app.bsky.actor.getProfile', { actor });
  } catch (err) {
    logger.debug(`[atproto] getProfile failed for ${actor}`, err);
    return null;
  }

  const normalized = mapProfileToNormalizedActor(profile);
  if (!normalized) {
    logger.debug(`[atproto] getProfile for ${actor} returned an unmappable profile`);
    return null;
  }

  return upsertAtprotoActor(normalized);
}
