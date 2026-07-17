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
 * A Bluesky handle is a bare DNS name. Its instance domain is the handle minus
 * its first label — but ONLY when that leaves a real ≥2-label domain:
 *   - `alice.bsky.social` (3 labels) → instance `bsky.social`.
 *   - `gothamist.com` (a 2-label apex custom domain) has no strippable parent —
 *     stripping would leave the bare TLD `com`, and using the handle itself as the
 *     domain renders the doubled `@gothamist.com@gothamist.com`. It keys to the
 *     Bluesky network host instead (`bsky.social`), rendering `@gothamist.com@bsky.social`.
 * The federated Oxy username is `<handle>@<instance-domain>`
 * (`alice.bsky.social@bsky.social`, `gothamist.com@bsky.social`) — the exact form
 * oxy-api's `PUT /users/resolve` binds (username domain must equal `domain`).
 *
 * Exported so the reingest repair script can DETECT the pre-fix doubled-handle bug
 * (a stored `FederatedActor.domain` that no longer equals `splitHandle(acct).domain`)
 * without re-fetching the profile, using the SAME derivation the upsert path uses.
 */
export function splitHandle(handle: string): { username: string; domain: string; federatedUsername: string } {
  const dot = handle.indexOf('.');
  // Strip the first label only if the remainder is still a multi-label domain.
  const parent = dot > 0 ? handle.slice(dot + 1) : handle;
  const domain = parent.includes('.') ? parent : BSKY_NETWORK_DOMAIN;
  return { username: handle, domain, federatedUsername: `${handle}@${domain}` };
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
    // A DID carries no host, so the Oxy identity is keyed on the handle's parent
    // domain. These are what the shared identity bridge sends to oxy-api.
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
