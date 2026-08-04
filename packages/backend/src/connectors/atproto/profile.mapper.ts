import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';
import { logger } from '../../utils/logger';
import type { FederatedActorRecord } from '../../db/federation/actorRecord';
import { setActorOxyUserId, upsertActor } from '../../db/federation/actorRepository';
import { resolveFederatedActorIdentity } from '../identity';
import {
  BSKY_NETWORK_DOMAIN,
  blueskyUsernameFromHandle,
  type NormalizedExternalActor,
} from '@oxyhq/federation';
import { describeDriverError, isUniqueViolation } from '../../db/pgErrors';
import { metrics } from '../../utils/metrics';
import { xrpcGet } from './xrpcClient';
import { PUBLIC_APPVIEW } from './constants';
import { isUnresolvedAtprotoHandle } from './unresolvedHandle';

/**
 * Counter a run can fail on when an actor row could not be written.
 *
 * The upsert is best-effort by design — a failure must not abort a feed import —
 * so the only thing standing between "one actor was dropped" and "every actor
 * from this instance is being dropped" is a number somebody can read. A `warn`
 * in a detached ingest path is not that.
 */
export const ACTOR_UPSERT_FAILED_METRIC = 'federated_actor_upsert_failed_total';

/**
 * Maps an `app.bsky.actor.getProfile` response into a network-neutral actor,
 * upserts the backing `federated_actors` row (`protocol:'atproto'`), and mints /
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
/**
 * The handle an actor is IDENTIFIED by, which is its real handle unless the
 * AppView could not verify one — in which case it is the DID.
 *
 * `handle.invalid` is Bluesky's error string for a failed handle↔DID
 * verification, so it is the same value for every affected account and is the
 * one thing in the atproto namespace guaranteed not to identify anybody. Every
 * key this connector writes is derived from the handle — `acct`, `username`,
 * and the `<local>@<domain>` username oxy-api binds — and all three carry a
 * uniqueness constraint, so the sentinel is refused for every account after the
 * first: no actor row, no Oxy user, and the account's posts dropped as orphans
 * by the no-orphan rule.
 *
 * The DID is the identifier atproto actually guarantees stable and unique, and
 * it is already this row's `uri`. It contains a `:`, which no DNS handle may, so
 * the substituted identity can never collide with a real one — and oxy-api's
 * `normalizeFederatedResolveUsername` splits on the FIRST `@`, so
 * `did:plc:…@bsky.social` binds to `bsky.social` exactly like any other handle.
 *
 * SELF-HEALING: nothing is stored under the sentinel, so the next refresh after
 * the remote fixes its DNS re-derives the real handle and rewrites the row
 * through the ordinary path. A DID-shaped handle in the UI is the honest
 * rendering of an account whose handle does not verify — it is what bsky.app
 * shows too — and it is strictly better than the account not existing.
 */
export function atprotoIdentityHandle(handle: string, did: string): string {
  return isUnresolvedAtprotoHandle(handle) ? did : handle;
}

export function splitHandle(handle: string): { username: string; domain: string; federatedUsername: string } {
  // The suffix rule itself lives in `@oxyhq/federation`'s bridge policy, beside
  // the Bluesky network record this connector's instance domain now comes from.
  // The same Bluesky account can also reach us over ActivityPub through Bridgy
  // Fed, and that path derives its username with this very function — so if the
  // two ever disagreed, one person would become two accounts. Sharing the rule
  // is what makes them agree by construction rather than by review.
  const username = blueskyUsernameFromHandle(handle);
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

  // Substituted HERE, at the one boundary the remote value enters, so the
  // sentinel reaches no derivation downstream — `handle` on this DTO is what
  // becomes the `acct` column and what the identity bridge binds.
  const identityHandle = atprotoIdentityHandle(handle, did);
  const { domain, federatedUsername } = splitHandle(identityHandle);
  // Bluesky text is third-party text: it carries whatever whitespace the author
  // (or their client) typed, and our clients render it faithfully
  // (`white-space: pre-wrap`). The display name is ONE LINE — a newline in it is
  // never meaningful — while the bio is a BODY whose paragraphs must survive.
  const displayName = typeof profile.displayName === 'string' ? normalizeInlineText(profile.displayName) : '';
  const bio = typeof profile.description === 'string' ? normalizeMultilineText(profile.description) : '';
  return {
    network: 'atproto',
    externalId: did,
    handle: identityHandle,
    // A DID carries no host and a handle is a whole DNS name, so an atproto actor's
    // Oxy identity is keyed on the Bluesky network domain (`bsky.social`). These are
    // what the shared identity bridge sends to oxy-api.
    federatedUsername,
    instanceDomain: domain,
    displayName: displayName || undefined,
    avatarUrl: profile.avatar || undefined,
    bannerUrl: profile.banner || undefined,
    // Empty is an ANSWER — "this account has no bio" — and it has to travel as
    // one. `PUT /users/resolve` writes `bio` only when the key is a string, and
    // `undefined` does not survive `JSON.stringify`, so mapping an empty bio to
    // `undefined` says "leave whatever you have" instead. An author who DELETES
    // their Bluesky bio would keep the old one on their Oxy profile forever, no
    // matter how many times we re-resolved them.
    bio,
    followersCount: typeof profile.followersCount === 'number' ? profile.followersCount : undefined,
    followingCount: typeof profile.followsCount === 'number' ? profile.followsCount : undefined,
    postsCount: typeof profile.postsCount === 'number' ? profile.postsCount : undefined,
  };
}

/**
 * Upsert the `federated_actors` row for a normalized atproto actor and resolve its
 * Oxy user. Returns the actor with `oxyUserId` populated when Oxy resolved it.
 *
 * Fails soft: if `resolveOxyExternalUser` returns null (e.g. oxy-api does not yet
 * accept a `did:` `actorUri`), the actor row is still upserted but `oxyUserId`
 * stays undefined — callers MUST NOT import posts for an unresolved author (no
 * orphan posts), exactly like the ActivityPub no-orphan invariant.
 */
export async function upsertAtprotoActor(actor: NormalizedExternalActor): Promise<NormalizedExternalActor> {
  const did = actor.externalId;
  // Substituted again (idempotent) rather than trusted, for the same reason the
  // bio is re-normalized below: this function is exported and does not require
  // its caller to have gone through `mapProfileToNormalizedActor`. A caller that
  // built the actor itself must not be able to write the sentinel into the three
  // uniquely-constrained columns derived here.
  const identityHandle = atprotoIdentityHandle(actor.handle, did);
  const { username, domain } = splitHandle(identityHandle);

  let fedActor: FederatedActorRecord | null = null;
  try {
    // The AP-shaped columns this profile has no analogue for are written at their
    // schema defaults rather than left alone. That is safe precisely because this
    // is the ONLY writer of an `atproto` actor row: a Bluesky account has no AP
    // inbox, no locked-followers flag and no verified-links table, so there is no
    // other writer whose values could be clobbered — and an empty `fields` list
    // therefore clears nothing that was ever populated.
    fedActor = await upsertActor(
      did,
      {
        protocol: 'atproto',
        username,
        domain,
        acct: identityHandle,
        // Normalized again (idempotent) rather than trusted: this function is
        // exported and does not require its caller to have gone through
        // `mapProfileToNormalizedActor`.
        summary: normalizeMultilineText(actor.bio ?? ''),
        avatarUrl: actor.avatarUrl,
        headerUrl: actor.bannerUrl,
        type: 'Person',
        manuallyApprovesFollowers: false,
        discoverable: true,
        memorial: false,
        suspended: false,
        followersCount: actor.followersCount ?? 0,
        followingCount: actor.followingCount ?? 0,
        postsCount: actor.postsCount ?? 0,
        lastFetchedAt: new Date(),
      },
      [],
    );
  } catch (err) {
    // Continuing with no row must not abort discovery — but it is NOT a benign
    // outcome, and this catch used to make it look like one. An unwritten row
    // means no `oxyUserId`, which the no-orphan rule turns into every one of
    // that account's posts being dropped, silently, from a detached path nobody
    // is reading. So the failure is COUNTED, and a unique violation — the shape
    // that says two DIDs are claiming one identity — is separated out and raised
    // to `error`, because it is a derivation bug in this file rather than the
    // handle genuinely having moved between accounts.
    //
    // `describeDriverError` rather than the error itself: postgres.js attaches
    // the failing statement AND its bound parameters, so logging the object
    // publishes every value the row carried.
    const failure = describeDriverError(err);
    const reason = isUniqueViolation(err) ? failure.constraint ?? 'unique_violation' : 'other';
    metrics.incrementCounter(ACTOR_UPSERT_FAILED_METRIC, 1, { protocol: 'atproto', reason });
    if (isUniqueViolation(err)) {
      logger.error('[atproto] federated actor upsert refused by a unique constraint', {
        did,
        ...failure,
      });
    } else {
      logger.warn('[atproto] failed to upsert federated actor', { did, ...failure });
    }

    // FAIL CLOSED. Continuing with the actor as-is is what makes this dangerous:
    // no row bound to this DID means identity merging can adopt whatever Oxy user
    // the PREVIOUS holder of this mutable handle was resolved to, and attribute
    // this actor's posts to them. Returning without an `oxyUserId` costs this
    // account's posts until a later refresh persists the DID safely — the
    // no-orphan rule drops them — which is the recoverable direction.
    return { ...actor, oxyUserId: undefined };
  }

  const existingOxyId = fedActor?.oxyUserId ?? undefined;
  // Routed through the shared merge rather than straight at the identity bridge:
  // the SAME Bluesky account can also reach us over ActivityPub through Bridgy
  // Fed, and whichever protocol arrives second must adopt the first's Oxy user
  // instead of minting a second identity under a username that is uniquely
  // indexed. Both directions have to go through it or the merge only works when
  // the bridged copy happens to arrive last.
  const oxyId = await resolveFederatedActorIdentity({ ...actor, oxyUserId: existingOxyId });
  if (!oxyId) {
    // Hard runtime dependency: oxy-api `PUT /users/resolve` must accept a `did:`
    // actorUri. Until it does this returns null — fail soft (no throw, no orphan).
    logger.warn('[atproto] import skipped while Oxy user is unresolved');
    return { ...actor, oxyUserId: undefined };
  }

  if (fedActor && fedActor.oxyUserId !== oxyId) {
    await setActorOxyUserId(fedActor.id, oxyId);
  }
  return { ...actor, oxyUserId: oxyId };
}

/**
 * Fetch a Bluesky profile (`app.bsky.actor.getProfile`), normalize it, upsert the
 * `federated_actors` row, and resolve its Oxy user. `actor` may be a handle or a DID.
 * Returns null when the profile cannot be fetched / mapped.
 */
export async function fetchAndUpsertAtprotoProfile(actor: string): Promise<NormalizedExternalActor | null> {
  let profile: AtprotoProfileView;
  try {
    profile = await xrpcGet<AtprotoProfileView>(PUBLIC_APPVIEW, 'app.bsky.actor.getProfile', { actor });
  } catch (err) {
    logger.debug('[atproto] getProfile failed', err);
    return null;
  }

  const normalized = mapProfileToNormalizedActor(profile);
  if (!normalized) {
    logger.debug('[atproto] getProfile returned an unmappable profile');
    return null;
  }

  return upsertAtprotoActor(normalized);
}
