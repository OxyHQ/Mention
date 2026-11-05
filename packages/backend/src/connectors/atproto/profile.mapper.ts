import { resolveAvatarUrl } from '../../utils/mediaResolver';
import { normalizeInlineText, normalizeMultilineText } from '@oxy.so/core';
import { logger } from '../../utils/logger';
import type { FederatedActorField, FederatedActorRecord } from '../../db/federation/actorRecord';
import { upsertActor } from '../../db/federation/actorRepository';
import type { ResolveExternalIdentityResponse } from '@oxy.so/contracts';
import { observeOxySource, resolveOxyIdentity, type ObservedOxySource } from '../oxyIdentity';
import { syncFederatedBannerInBackground } from '../../db/federation/bannerMirrorRepository';
import { reconcileActorIdentityProjection } from '../../services/ActorIdentityProjectionService';
import { trustedRemoteCreatedAt } from '../../services/federation/remoteProfileStats';
import {
  atprotoIdentityHandle,
  BSKY_NETWORK_DOMAIN,
  blueskyUsernameFromHandle,
  type NormalizedExternalActor,
} from '@oxy.so/federation';
import { describeDriverError, isUniqueViolation } from '@oxy.so/db';
import { metrics } from '../../utils/metrics';
import { isDid } from './constants';
import { oxyErrorStatus } from '../../services/oxyFiles/oxyErrors';

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
 * Maps the `app.bsky.actor.getProfile` view Oxy verified into a network-neutral
 * actor and upserts the backing `federated_actors` row (`protocol:'atproto'`)
 * under the Oxy user Oxy resolved it to.
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
  /** ISO 8601 — when the account was created. */
  createdAt?: string;
  /** `com.atproto.label.defs#label`s on the account, its own self-labels among them. */
  labels?: { val?: string }[];
  /** The profile's links (`app.bsky.actor.link` records, hydrated by the AppView). */
  links?: { url?: string; title?: string }[];
}

/** No profile shows more links than this; Bluesky's own editor allows fewer. */
const MAX_PROFILE_LINKS = 10;

/**
 * The profile's links as the actor's metadata rows: the title as the name and the
 * URL as the value, the shape an ActivityPub `PropertyValue` is stored in, so one
 * table and one renderer serve both networks. Only `http(s)` URLs are kept, and a
 * link with no title is named by its host. Never verified: Bluesky does not prove
 * a link the way `rel="me"` does.
 */
export function atprotoProfileLinks(profile: AtprotoProfileView): FederatedActorField[] {
  if (!Array.isArray(profile.links)) return [];
  const fields: FederatedActorField[] = [];
  for (const link of profile.links) {
    if (fields.length >= MAX_PROFILE_LINKS) break;
    if (typeof link?.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const title = typeof link.title === 'string' ? normalizeInlineText(link.title) : '';
    fields.push({ name: title || url.hostname, value: url.href });
  }
  return fields;
}

/**
 * Bluesky's opt-out from signed-out visibility: an account self-labelled
 * `!no-unauthenticated` asks apps not to show its profile or posts to anyone
 * who is not signed in. Read from any source — a label can only make an
 * account LESS visible, never more.
 */
export const NO_UNAUTHENTICATED_LABEL = '!no-unauthenticated';

/** Whether this profile hides from signed-out readers ({@link NO_UNAUTHENTICATED_LABEL}). */
export function atprotoRequiresSignIn(profile: AtprotoProfileView): boolean {
  return (
    Array.isArray(profile.labels) &&
    profile.labels.some((label) => label?.val === NO_UNAUTHENTICATED_LABEL)
  );
}

/** What the profile says about the account that the network-neutral actor has no field for. */
export interface AtprotoProfileFacts {
  /** The account's own creation date — the profile's "Joined". */
  remoteCreatedAt?: Date;
  /** {@link atprotoRequiresSignIn}. Absent is false. */
  requiresSignIn?: boolean;
  /** {@link atprotoProfileLinks}. Absent is none. */
  links?: FederatedActorField[];
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
 */
export function splitHandle(handle: string): {
  username: string;
  domain: string;
  federatedUsername: string;
} {
  // The suffix rule itself lives in `@oxy.so/federation`'s bridge policy, beside
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
export function mapProfileToNormalizedActor(
  profile: AtprotoProfileView,
): NormalizedExternalActor | null {
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
  const displayName =
    typeof profile.displayName === 'string' ? normalizeInlineText(profile.displayName) : '';
  const bio =
    typeof profile.description === 'string' ? normalizeMultilineText(profile.description) : '';
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
 * Upsert the `federated_actors` row for a normalized atproto actor under the Oxy
 * user Oxy `resolved` it to. Returns the actor with `oxyUserId` populated, or
 * without one when the row could not be written or projected — callers MUST NOT
 * import posts for an unresolved author (no orphan posts), exactly like the
 * ActivityPub no-orphan invariant.
 */
export async function upsertAtprotoActor(
  actor: NormalizedExternalActor,
  resolved: ResolveExternalIdentityResponse,
  profileFacts: AtprotoProfileFacts = {},
): Promise<NormalizedExternalActor> {
  const did = actor.externalId;
  if (resolved.externalIdentity.actorUri !== did) {
    logger.warn('[atproto] Oxy resolved a different source actor', { did });
    return { ...actor, oxyUserId: undefined };
  }
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
    // inbox and no locked-followers flag, so there is no other writer whose values
    // could be clobbered. The metadata rows are the profile's links, replaced on
    // every read, so a link removed on Bluesky is removed here.
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
        summary: resolved.user.bio ?? '',
        avatarUrl: resolveAvatarUrl(resolved.user.avatar),
        networkAcct: resolved.externalIdentity.canonicalAcct,
        headerUrl: actor.bannerUrl,
        type: 'Person',
        manuallyApprovesFollowers: false,
        discoverable: true,
        // Bluesky has no `indexable`; its one opt-out is the signed-out label,
        // which keeps search engines out as well.
        requiresSignIn: profileFacts.requiresSignIn ?? false,
        memorial: false,
        suspended: false,
        // A count the profile did not carry is unknown, not zero.
        followersCount: actor.followersCount ?? null,
        followingCount: actor.followingCount ?? null,
        postsCount: actor.postsCount ?? null,
        remoteCreatedAt: profileFacts.remoteCreatedAt,
        lastFetchedAt: new Date(),
      },
      profileFacts.links ?? [],
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
    const reason = isUniqueViolation(err) ? (failure.constraint ?? 'unique_violation') : 'other';
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

  if (!fedActor) return { ...actor, oxyUserId: undefined };
  const projection = await reconcileActorIdentityProjection({
    actorUri: did,
    oxyUserId: resolved.user.id,
    networkAcct: resolved.externalIdentity.canonicalAcct,
    check: 'refresh',
  });
  if (projection.refusal) return { ...actor, oxyUserId: undefined };
  // The banner is Mention's own (`user_settings.profile_header_image`): sync it
  // with the profile just read — queued for the sweep, or cleared once removed.
  syncFederatedBannerInBackground({
    oxyUserId: resolved.user.id,
    actorUri: did,
    bannerUrl: actor.bannerUrl,
  });
  return {
    ...actor,
    oxyUserId: resolved.user.id,
    federatedUsername: resolved.user.username,
    instanceDomain: resolved.externalIdentity.network,
    displayName: resolved.user.name?.displayName,
    avatarUrl: resolveAvatarUrl(resolved.user.avatar),
    bio: resolved.user.bio ?? '',
  };
}

/**
 * Oxy's fresh, verified read of a Bluesky account by handle or DID. A handle is
 * resolved by Oxy (which verifies handle→DID); when Oxy answers it from its
 * registry, without reading the source, the DID it names is read once.
 */
async function observeAtprotoSource(actor: string): Promise<ObservedOxySource | undefined> {
  let did = actor;
  if (!isDid(actor)) {
    let known: ResolveExternalIdentityResponse;
    try {
      known = await resolveOxyIdentity({ handle: actor });
    } catch (error) {
      if (oxyErrorStatus(error) === 404) return undefined;
      throw error;
    }
    if (known.externalIdentity.protocol !== 'atproto') return undefined;
    if (known.sourceDocument) return { ...known, sourceDocument: known.sourceDocument };
    did = known.externalIdentity.actorUri;
  }
  return (await observeOxySource({ actorUri: did, protocol: 'atproto' })).resolved;
}

/**
 * Read a Bluesky profile through Oxy, normalize it, upsert the `federated_actors`
 * row, and return it with its Oxy user. `actor` may be a handle or a DID.
 *
 * ONE `app.bsky.actor.getProfile` per call, made by Oxy: Oxy reads the profile to
 * verify the account and returns the view it read (`sourceDocument`), so the
 * banner, counts, creation date and labels come from that answer — Mention never
 * calls `getProfile` itself. Returns null when Oxy cannot verify the account.
 */
export async function fetchAndUpsertAtprotoProfile(
  actor: string,
): Promise<NormalizedExternalActor | null> {
  let resolved: ObservedOxySource | undefined;
  try {
    resolved = await observeAtprotoSource(actor);
  } catch (err) {
    logger.warn('[atproto] Oxy identity resolution failed', { err });
    return null;
  }
  if (!resolved) {
    logger.debug('[atproto] Oxy could not verify the profile');
    return null;
  }

  const profile = resolved.sourceDocument as AtprotoProfileView;
  const normalized = mapProfileToNormalizedActor(profile);
  if (!normalized) {
    logger.debug('[atproto] getProfile returned an unmappable profile');
    return null;
  }

  // The account's own creation date is the profile's "Joined", not the day
  // Mention discovered it; the network-neutral actor has no field for it.
  return upsertAtprotoActor(normalized, resolved, {
    remoteCreatedAt:
      typeof profile.createdAt === 'string'
        ? trustedRemoteCreatedAt(new Date(profile.createdAt))
        : undefined,
    requiresSignIn: atprotoRequiresSignIn(profile),
    links: atprotoProfileLinks(profile),
  });
}
