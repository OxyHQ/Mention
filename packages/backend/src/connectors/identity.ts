import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import UserSettings from '../models/UserSettings';
import { invalidate as invalidateUserSummaryCache } from '../services/userSummaryCache';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../services/mediaCache/cacheWorker';
import { FEDERATED_BANNER_DOWNLOAD_POLICY } from '../services/mediaCache/policy';
import { isAbsoluteHttpUrl, getRemoteHost } from './shared/url';
import type { NormalizedExternalActor } from '@oxyhq/federation';
import { createIdentityBridge, type ServiceRequest, type ServiceRequestMethod } from '@oxyhq/federation/node';
import FederatedActor, { type IFederatedActor } from '../models/FederatedActor';

/**
 * The network-neutral identity bridge: resolve a normalized external actor to its
 * Oxy user (`PUT /users/resolve`), and archive/delete a permanently-gone actor's
 * Oxy identity. The bridge LOGIC — the resolve body, the error classification, the
 * outcome discriminants — lives in `@oxyhq/federation` so BOTH connectors
 * (ActivityPub + atproto) and every Oxy app backend mint identities identically.
 *
 * This module is the Mention wiring: it supplies the service-scoped oxy-api
 * transport, the post-resolve user-summary cache invalidation, and the banner
 * mirror (which uses Mention's own media cache — the one piece that stays
 * app-side). `resolveOxyExternalUser` / `reportFederatedActorGone` /
 * `deleteFederatedActorIdentity` keep their names + signatures for every caller.
 */

/** Service-scoped oxy-api request, resolved at call time (the client is per-request). */
const callOxyService: ServiceRequest = <T>(method: ServiceRequestMethod, path: string, body?: unknown): Promise<T> =>
  getServiceOxyClient().makeServiceRequest<T>(method, path, body);

const identityBridge = createIdentityBridge({
  makeServiceRequest: callOxyService,
  // A re-resolve can refresh the federated actor's display name / avatar in Oxy;
  // evict any warm user-summary cache entry so the next feed hydration reads fresh.
  onUserResolved: (oxyUserId) => invalidateUserSummaryCache([oxyUserId]),
  // Best-effort banner mirror through Mention's own media cache (see below). It
  // handles its own errors and never throws, so it can never drop a resolved user.
  mirrorBanner: async (bannerUrl, oxyUserId, actorUri) => {
    await mirrorFederatedBanner(bannerUrl, oxyUserId, actorUri);
  },
  logger: {
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
  },
});

/**
 * Resolve/mint the Oxy user a normalized external actor maps to (via
 * `PUT /users/resolve`), then mirror its banner. Returns the resolved Oxy user id,
 * or `null` when Oxy is unreachable / returns no id (callers must then skip, never
 * persisting an orphan). This is `NetworkConnector.mapIdentity`'s implementation,
 * shared by the ActivityPub and atproto connectors.
 */
export const resolveOxyExternalUser = identityBridge.resolveExternalUser;

/**
 * Teardown counterpart: tell oxy-api that a federated actor is permanently gone so
 * it ARCHIVES the linked Oxy identity (removing it from search). Idempotent on the
 * Oxy side. Never throws — a transient failure surfaces as the `'failed'` outcome.
 */
export const reportFederatedActorGone = identityBridge.reportActorGone;

/**
 * The irreversible counterpart of {@link reportFederatedActorGone}: ask oxy-api to
 * HARD-DELETE the Oxy identity (User + follow edges/blocks) a permanently-gone
 * actor maps to. Only the `purgeGoneFederatedActors` one-shot calls it, after
 * re-confirming the remote actor still returns 410 Gone. Never throws.
 */
export const deleteFederatedActorIdentity = identityBridge.deleteActorIdentity;

/**
 * The `<local>@<domain>` identity a stored actor row is held under.
 *
 * A BRIDGED row carries it explicitly in `networkAcct`, because its identity is
 * not derivable from the host it arrived through. Every other row's identity IS
 * `username@domain` — which is how the atproto connector stores a Bluesky
 * account (`georgemonbiot` + `bsky.social`) without ever writing `networkAcct`.
 *
 * Both shapes have to be searchable or the merge below cannot see across them,
 * and the pair it most needs to see across is exactly that one: a Bluesky account
 * we hold NATIVELY over atproto and AGAIN over ActivityPub through Bridgy Fed.
 * Matching only `networkAcct` would miss all 10,066 native rows — and the
 * alternative, backfilling `networkAcct` onto every one of them, buys nothing a
 * second query branch does not.
 */
function identityQueryShapes(federatedUsername: string): Record<string, unknown>[] {
  const atIndex = federatedUsername.indexOf('@');
  const shapes: Record<string, unknown>[] = [{ networkAcct: federatedUsername }];
  if (atIndex > 0 && atIndex < federatedUsername.length - 1) {
    shapes.push({
      networkAcct: { $exists: false },
      username: federatedUsername.slice(0, atIndex),
      domain: federatedUsername.slice(atIndex + 1),
    });
  }
  return shapes;
}

/**
 * Resolve a normalized actor to its Oxy user, MERGING separate copies of the same
 * upstream person into one identity.
 *
 * An upstream handle is globally unique on its own network — there is one
 * `@wired` on X, one `georgemonbiot.bsky.social` on Bluesky — so two actor rows
 * that resolve to the same `<handle>@<network>` are not two people who happen to
 * collide. They are one person reaching us twice: mirrored by two bridges, or (the
 * larger case) held NATIVELY over one protocol and again over ActivityPub through
 * a bridge.
 *
 * Minting a second Oxy identity for the second copy is not merely untidy, it does
 * not work: `PUT /users/resolve` keys on the actor URI while the username carries
 * a unique index, so the second copy is refused outright. The second row therefore
 * ADOPTS the first row's Oxy user.
 *
 * Reversible by construction. Nothing is rewritten and nothing is deleted — the
 * absorbed row keeps its own URI, acct, domain and content, and shares only which
 * identity it points at. Drop a bridge from the policy and its rows derive their
 * own identity again on the next refresh.
 *
 * ACROSS a network, never between networks: `('x','nate')` and
 * `('instagram','nate')` are unrelated strings that happen to match, and merging
 * them would be impersonation. The key is always the full `<handle>@<network>`,
 * so that can never happen by construction.
 *
 * Two ingests racing can both find no owner and both try to mint; oxy-api's unique
 * index refuses the loser, which surfaces as an unresolved actor (no orphan is
 * written) and the next refresh settles. A rare, self-correcting outcome — a lock
 * around a cross-service call would be the worse trade.
 */
export async function resolveFederatedActorIdentity(
  actor: NormalizedExternalActor,
  opts?: { forceAvatarRefresh?: boolean },
): Promise<string | null> {
  // An actor whose identity IS its own protocol acct cannot share that identity
  // with another row — an acct is already unique per host — so there is nothing
  // to look for, and looking would put a DB round trip on every actor of every
  // ordinary instance. This is the overwhelmingly common path.
  if (actor.federatedUsername === actor.handle) {
    return resolveOxyExternalUser(actor, opts);
  }

  try {
    const owner = await FederatedActor.findOne(
      {
        $or: identityQueryShapes(actor.federatedUsername),
        uri: { $ne: actor.externalId },
        oxyUserId: { $exists: true, $ne: null },
      },
      { uri: 1, domain: 1, oxyUserId: 1 },
    ).lean<Pick<IFederatedActor, 'uri' | 'domain' | 'oxyUserId'>>();

    // A valid collision has EXACTLY ONE actor per source domain. A bridge holds
    // one actor per upstream handle, so two actors on the SAME domain resolving
    // to one identity is impossible under a correct rule — it means the
    // derivation is broken, most likely yielding a constant, and merging on it
    // would collapse every actor on that domain into one person. Refuse; never
    // merge. Cheapest possible guard against the worst possible outcome.
    // The domain the actor itself came from. An ActivityPub acct carries it after
    // the `@`; an atproto handle is a whole DNS name with NO `@` at all
    // (`georgemonbiot.bsky.social`), and for those the source domain is the
    // network — which is what `instanceDomain` holds.
    //
    // Reading it off the handle unconditionally made this guard INERT on the
    // atproto path: `lastIndexOf('@')` returns -1, `slice(0)` hands back the whole
    // handle, and comparing `georgemonbiot.bsky.social` against a stored domain of
    // `bsky.social` can never match. So the one guard built to catch a broken
    // derivation collapsing a domain onto one identity would not have fired for
    // native Bluesky rows. It is unreachable today — a default handle's local part
    // is a single label and a custom-domain handle must contain a dot, so the two
    // cannot derive the same string — but that is a property of Bluesky's handle
    // rules, not of this code, and it is not what the guard should rest on.
    const sourceDomain = actor.handle.includes('@')
      ? actor.handle.slice(actor.handle.lastIndexOf('@') + 1)
      : actor.instanceDomain;
    if (owner && owner.domain === sourceDomain) {
      logger.error(
        '[FedSync] two actors on one source domain resolve to the same identity — '
        + 'the derivation rule is broken; refusing to merge',
        { actor: actor.externalId, owner: owner.uri, networkAcct: actor.federatedUsername },
      );
      return null;
    }

    if (owner?.oxyUserId) {
      // Identifiers ride in the structured payload, never interpolated into the
      // message — the backend logging policy holds every call site to that.
      logger.info(
        '[FedSync] identity is already held by another actor; adopting its Oxy user',
        { actor: actor.externalId, networkAcct: actor.federatedUsername, owner: owner.uri },
      );
      return owner.oxyUserId;
    }
  } catch (err) {
    // A failed lookup must not lose the actor: fall through and resolve normally.
    // The worst case is the duplicate this merge exists to avoid, which oxy-api
    // then refuses — visible and recoverable, unlike dropping the actor.
    logger.warn('[FedSync] duplicate-identity owner lookup failed', { actor: actor.externalId, err });
  }

  return resolveOxyExternalUser(actor, opts);
}

/**
 * Best-effort outcome of {@link mirrorFederatedBanner}. `permanent` distinguishes a
 * transient failure (bad service credential, upstream 5xx, upload rejection — worth
 * retrying) from a permanently-unavailable banner (dead/oversized/non-image — never
 * retry), so the one-shot backfill caller can decide whether to back off and retry.
 */
export interface MirrorBannerResult {
  ok: boolean;
  permanent: boolean;
}

/**
 * Mirror a federated actor's remote banner into a durable, PUBLIC Oxy asset, then
 * store its file id in Mention's per-user `UserSettings.profileHeaderImage` (the
 * same field a LOCAL user's banner uses, read back by the profile-design
 * endpoint). This reuses the canonical federated-media path
 * (`persistRemoteMediaForFederatedOwnerDetailed` →
 * `POST /assets/service/federation`): SSRF-safe download → streamed upload as a
 * public, CDN-reachable file owned by the resolved federated user — the SAME
 * service-token flow that already mirrors federated post media and the avatar. It
 * deliberately does NOT use the SDK's `uploadProfileBanner`, which routes through
 * the USER-authenticated `POST /assets/upload` and is rejected `401 UNAUTHORIZED`
 * on the service client, so the banner was never stored.
 *
 * Unlike post media it passes `FEDERATED_BANNER_DOWNLOAD_POLICY`, restricting the
 * download to `image/` within `FEDERATED_BANNER_MAX_BYTES`. This call site is
 * reached on EVERY successful actor resolve with no per-URL dedup, so it must not
 * inherit the generic federated-media allowance of a video- or audio-sized body:
 * a banner is a still image, and a remote actor advertising a video as its `image`
 * would otherwise have every resolve mirror that body to S3 and run poster
 * extraction over it.
 *
 * Best-effort: returns `{ ok: true }` when the banner was stored, otherwise
 * `{ ok: false, permanent }`. A non-http url is `permanent: true`. Transient
 * failures are surfaced at `warn`; permanent ones stay quiet. Shared by the live
 * actor-resolution path (the identity bridge above, which ignores the result) and
 * the one-shot `backfillFederatedBanners` script (which inspects `permanent`).
 */
export async function mirrorFederatedBanner(
  bannerUrl: string,
  oxyUserId: string,
  actorUri: string,
): Promise<MirrorBannerResult> {
  if (!isAbsoluteHttpUrl(bannerUrl)) {
    return { ok: false, permanent: true };
  }

  const remoteHost = getRemoteHost(bannerUrl);

  try {
    const result = await persistRemoteMediaForFederatedOwnerDetailed(
      bannerUrl,
      oxyUserId,
      {
        role: 'banner',
        actorUri,
        remoteHost,
      },
      FEDERATED_BANNER_DOWNLOAD_POLICY,
    );

    if (result.ok) {
      await UserSettings.updateOne(
        { oxyUserId },
        { $set: { profileHeaderImage: result.media.oxyFileId } },
        { upsert: true },
      );
      return { ok: true, permanent: false };
    }

    if (!result.permanent) {
      // Surface transient failures (bad service credential, upstream 5xx, upload
      // rejection) at `warn` — a silent `debug` previously hid a total outage where
      // 0 federated banners were ever stored. Permanently unavailable banners
      // (dead/oversized/non-image) are expected and stay quiet.
      logger.warn('Failed to mirror federated actor banner', {
        reason: result.reason,
        remoteHost,
      });
    }

    return { ok: false, permanent: result.permanent };
  } catch (bannerErr) {
    // Honor the documented best-effort contract: a throw from the media persist or
    // the `UserSettings` write must never propagate. Treat it as a transient
    // (retryable) failure so the backfill still retries, and swallow it.
    logger.warn('Failed to mirror federated actor banner', {
      error: bannerErr,
      remoteHost,
    });
    return { ok: false, permanent: false };
  }
}
