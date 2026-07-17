import { getErrorMessage, getErrorStatus } from '@oxyhq/core';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import UserSettings from '../models/UserSettings';
import { invalidate as invalidateUserSummaryCache } from '../services/userSummaryCache';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../services/mediaCache/cacheWorker';
import { isAbsoluteHttpUrl, getRemoteHost } from './shared/url';
import type { NormalizedExternalActor } from '@oxyhq/federation';

/**
 * Network-neutral identity bridge: resolve a normalized external actor to its
 * Oxy user (`oxyUserId`) by upserting it through Oxy's service-scoped
 * `PUT /users/resolve`, and mirror its profile banner to Oxy.
 *
 * Extracted verbatim from `ActivityPubConnector`'s actor-resolution path so BOTH
 * connectors (ActivityPub today, atproto next) mint Oxy identities through the
 * SAME helper — this is `NetworkConnector.mapIdentity`'s implementation. It is
 * deliberately protocol-agnostic: it reads only the normalized actor fields, so
 * the calling connector is responsible for stamping its own actor row with the
 * returned id.
 */

/**
 * Resolve/mint the Oxy user a normalized external actor maps to.
 *
 * Upserts the federated user via `PUT /users/resolve` (service-token scoped) so
 * profile changes (avatar, name, bio) stay synced — creating the user when it
 * does not exist. Returns the resolved Oxy user id, or `null` when Oxy is
 * unreachable / returns no id (callers must then skip, never persisting an
 * orphan). After resolution, the actor's banner is mirrored into a durable,
 * public Oxy asset via the SAME service-token media path as federated post media
 * (best-effort; failures are logged, not propagated).
 *
 * @param actor the normalized external actor.
 * @param opts.forceAvatarRefresh when true, tell Oxy to re-download and replace
 *   the federated avatar even if it already stored a file id (refresh paths).
 */
export async function resolveOxyExternalUser(
  actor: NormalizedExternalActor,
  opts: { forceAvatarRefresh?: boolean } = {},
): Promise<string | null> {
  const forceAvatarRefresh = opts.forceAvatarRefresh ?? false;
  try {
    const oxyClient = getServiceOxyClient();
    // The connector owns deriving the canonical `local@domain` username and the
    // instance domain for its protocol, so this bridge stays protocol-agnostic:
    // it never has to guess a domain out of a bare atproto handle or a hostless
    // DID. oxy-api binds the two (username domain must equal `domain`).
    const oxyUser: { _id?: string; id?: string } | null = await oxyClient.makeServiceRequest('PUT', '/users/resolve', {
      type: 'federated',
      username: actor.federatedUsername,
      actorUri: actor.externalId,
      domain: actor.instanceDomain,
      displayName: actor.displayName,
      avatar: actor.avatarUrl,
      bio: actor.bio,
      // On refresh, tell Oxy to re-download and replace the avatar even if it
      // already stored a file ID. Coordinated with oxy-api's
      // `refresh` / `forceAvatarRefresh` flag on PUT /users/resolve.
      refresh: forceAvatarRefresh,
      forceAvatarRefresh,
    });
    const oxyId = String(oxyUser?._id || oxyUser?.id || '');
    if (!oxyId) return null;

    // A re-resolve can refresh the federated actor's display name / avatar in
    // Oxy. Evict any warm user-summary cache entry so the next feed hydration
    // reads the updated Oxy user instead of the stale 10-min cached copy.
    await invalidateUserSummaryCache([oxyId]);

    if (actor.bannerUrl) {
      // Best-effort on the live path: the outcome (stored / transient / permanent)
      // only matters to the one-shot backfill, which inspects the return to decide
      // whether to retry. Failures here are already logged inside the helper.
      await mirrorFederatedBanner(actor.bannerUrl, oxyId, actor.externalId);
    }

    return oxyId;
  } catch (resolveErr) {
    logger.warn(`Failed to resolve Oxy user for ${actor.externalId}:`, resolveErr);
    return null;
  }
}

/**
 * oxy-api service route this bridge posts to when a remote actor is permanently
 * gone. Same service auth (scope `federation:write`) and same
 * `getServiceOxyClient().makeServiceRequest` transport as the inbound-follow
 * bridge (`inbox.service.ts` `bridgeFollowEdge` → `POST /federation/follow`).
 */
const ACTOR_GONE_PATH = '/federation/actor-gone';

/** The `{ data }`-unwrapped body oxy-api returns for a 200 `POST /federation/actor-gone`. */
interface ActorGoneResponse {
  oxyUserId: string;
  accountStatus: 'archived';
  alreadyArchived: boolean;
}

/**
 * Outcome discriminant of {@link reportFederatedActorGone}. NEVER thrown — both
 * callers (the live 410 tombstone in `actor.service.ts` and the one-shot
 * `pruneGoneFederatedActors` sweep) are fail-soft, so the transient/retryable
 * case is surfaced as a value (`'failed'`) rather than an exception a sweep would
 * have to catch to keep going.
 *
 *  - `archived` — Oxy archived a previously-active identity (removed from search).
 *  - `already`  — the identity was already archived (idempotent no-op, still 200).
 *  - `skipped`  — nothing to report, or oxy-api returned a PERMANENT client error
 *                 (400 bad body / 403 missing scope / 404 no such user / 409 target
 *                 not `type:'federated'`). Non-retryable — logged and swallowed.
 *  - `failed`   — a genuinely transient failure (5xx, 408/429, network, or an
 *                 unclassifiable transport error). Retryable: the caller may leave
 *                 the actor for a later pass.
 */
export type ReportActorGoneOutcome = 'archived' | 'already' | 'skipped' | 'failed';

/**
 * Teardown counterpart of {@link resolveOxyExternalUser}: tell oxy-api that a
 * federated actor is permanently gone so it archives the linked Oxy identity
 * (`accountStatus:'archived'`, removing it from search). Idempotent on the Oxy
 * side — a repeat call returns 200 with `alreadyArchived:true`.
 *
 * Mirrors the follow-bridge's exact client/auth pattern: the service-authed
 * `getServiceOxyClient().makeServiceRequest('POST', '/federation/actor-gone', …)`
 * under scope `federation:write`. `makeServiceRequest` unwraps the API's `{ data }`
 * envelope, so the resolved value is the inner {@link ActorGoneResponse}.
 *
 * Error policy (see {@link ReportActorGoneOutcome}): PERMANENT 4xx responses
 * (400/403/404/409 — all non-retryable per the contract) are logged and swallowed
 * to `'skipped'` so a bulk sweep is never aborted by one dead actor; only
 * genuinely transient failures (5xx, 408/429, network) surface as `'failed'` for
 * the caller to retry. This function never throws.
 */
export async function reportFederatedActorGone(oxyUserId: string): Promise<ReportActorGoneOutcome> {
  const id = oxyUserId.trim();
  if (!id) return 'skipped';

  try {
    const data = await getServiceOxyClient().makeServiceRequest<ActorGoneResponse>(
      'POST',
      ACTOR_GONE_PATH,
      { oxyUserId: id },
    );
    const alreadyArchived = data?.alreadyArchived === true;
    logger.info(`[Federation] oxy-api archived gone actor ${id}`, { alreadyArchived });
    return alreadyArchived ? 'already' : 'archived';
  } catch (error) {
    const httpStatus = getErrorStatus(error);
    const reason = getErrorMessage(error);

    // Permanent client errors (400 bad body, 403 missing scope, 404 no such user,
    // 409 target not `type:'federated'`) are non-retryable per the contract. 408
    // and 429 are excluded — those are transient and fall through to `'failed'`.
    if (
      httpStatus !== undefined &&
      httpStatus >= 400 &&
      httpStatus < 500 &&
      httpStatus !== 408 &&
      httpStatus !== 429
    ) {
      logger.warn(`[Federation] actor-gone report for ${id} rejected (HTTP ${httpStatus}, permanent)`, { reason });
      return 'skipped';
    }

    // Everything else — 5xx, 408/429, a network failure, or an unclassifiable
    // transport error — is transient. Surface as `'failed'` so the caller can
    // leave the actor for a later pass instead of permanently skipping it.
    logger.warn(`[Federation] actor-gone report for ${id} failed transiently; leaving for retry`, {
      status: httpStatus,
      reason,
    });
    return 'failed';
  }
}

/**
 * oxy-api service route that HARD-DELETES a federated actor's Oxy identity — the
 * irreversible teardown counterpart of the (reversible) archive
 * {@link reportFederatedActorGone} performs. Same service auth (scope
 * `federation:write`) and same `getServiceOxyClient().makeServiceRequest`
 * transport as every other identity bridge (`/users/resolve`, `/federation/follow`,
 * `/federation/actor-gone`). Only the `purgeGoneFederatedActors` one-shot calls it,
 * after re-confirming the remote actor is STILL 410 Gone.
 */
const ACTOR_DELETE_PATH = '/federation/actor-delete';

/** The `{ data }`-unwrapped body oxy-api returns for a 200 `POST /federation/actor-delete`. */
interface ActorDeleteResponse {
  oxyUserId: string;
  /** Whether an Oxy `User` actually existed and was deleted (false ⇒ idempotent no-op). */
  deleted: boolean;
  /** Follow edges removed on the Oxy side (both directions, counts repaired). */
  followEdgesRemoved: number;
}

/**
 * Outcome discriminant of {@link deleteFederatedActorIdentity}. NEVER thrown — the
 * one-shot purge sweep is fail-soft, so the transient/retryable case is surfaced as
 * a value (`'failed'`) rather than an exception. Mirrors {@link ReportActorGoneOutcome}.
 *
 *  - `deleted` — oxy-api hard-deleted a live Oxy identity (+ its follow edges/blocks).
 *  - `absent`  — the identity was already gone (200 with `deleted:false`, idempotent).
 *                Like `deleted`, this CONFIRMS the Oxy side is clean — the purge may
 *                safely drop the `FederatedActor` anchor.
 *  - `skipped` — nothing to delete, or oxy-api returned a PERMANENT client error
 *                (400 bad body / 403 missing scope / 409 target not `type:'federated'`).
 *                Non-retryable — logged and swallowed. The identity is NOT confirmed
 *                gone, so the caller must KEEP the `FederatedActor` anchor.
 *  - `failed`  — a genuinely transient failure (5xx, 408/429, network). Retryable: the
 *                caller must KEEP the `FederatedActor` anchor so a later run finishes.
 */
export type DeleteActorIdentityOutcome = 'deleted' | 'absent' | 'skipped' | 'failed';

/**
 * Ask oxy-api to HARD-DELETE the Oxy identity a permanently-gone federated actor
 * maps to — the Oxy `User` plus all its Follow edges (both directions, counts
 * repaired), Blocks, and caches. Irreversible on the Oxy side; the caller
 * ({@link ../scripts/purgeGoneFederatedActors}) only invokes it after re-verifying
 * the remote actor still returns 410 Gone.
 *
 * Mirrors {@link reportFederatedActorGone} EXACTLY: the service-authed
 * `getServiceOxyClient().makeServiceRequest('POST', '/federation/actor-delete', …)`
 * under scope `federation:write`, `{ data }`-unwrapped to {@link ActorDeleteResponse}.
 *
 * Error policy (see {@link DeleteActorIdentityOutcome}): PERMANENT 4xx responses
 * (400/403/409 — all non-retryable per the contract) are logged and swallowed to
 * `'skipped'`; only genuinely transient failures (5xx, 408/429, network) surface as
 * `'failed'`. This function NEVER throws — a sweep over thousands of actors is never
 * aborted by one dead actor, and a `'skipped'`/`'failed'` tells the caller to keep
 * the `FederatedActor` row as a retry anchor (so a surviving Oxy user is never
 * orphaned without a record to reconcile it).
 */
export async function deleteFederatedActorIdentity(oxyUserId: string): Promise<DeleteActorIdentityOutcome> {
  const id = oxyUserId.trim();
  if (!id) return 'skipped';

  try {
    const data = await getServiceOxyClient().makeServiceRequest<ActorDeleteResponse>(
      'POST',
      ACTOR_DELETE_PATH,
      { oxyUserId: id },
    );
    const deleted = data?.deleted === true;
    logger.info(
      `[Federation] oxy-api ${deleted ? 'hard-deleted' : 'found no'} identity for gone actor ${id}`,
      { followEdgesRemoved: data?.followEdgesRemoved ?? 0 },
    );
    return deleted ? 'deleted' : 'absent';
  } catch (error) {
    const httpStatus = getErrorStatus(error);
    const reason = getErrorMessage(error);

    // Permanent client errors (400 bad body, 403 missing scope, 409 target not
    // `type:'federated'`) are non-retryable per the contract. 408 and 429 are
    // excluded — those are transient and fall through to `'failed'`.
    if (
      httpStatus !== undefined &&
      httpStatus >= 400 &&
      httpStatus < 500 &&
      httpStatus !== 408 &&
      httpStatus !== 429
    ) {
      logger.warn(`[Federation] actor-delete for ${id} rejected (HTTP ${httpStatus}, permanent)`, { reason });
      return 'skipped';
    }

    // Everything else — 5xx, 408/429, a network failure, or an unclassifiable
    // transport error — is transient. Surface as `'failed'` so the caller keeps the
    // actor's `FederatedActor` anchor and a later pass finishes the Oxy delete.
    logger.warn(`[Federation] actor-delete for ${id} failed transiently; leaving for retry`, {
      status: httpStatus,
      reason,
    });
    return 'failed';
  }
}

/**
 * Mirror a federated actor's remote banner into a durable, PUBLIC Oxy asset, then
 * store its file id in Mention's per-user `UserSettings.profileHeaderImage` (the
 * same field a LOCAL user's banner uses, read back by the profile-design
 * endpoint). This reuses the canonical federated-media path
 * (`persistRemoteMediaForFederatedOwnerDetailed` →
 * `POST /assets/service/federation`): SSRF-safe download → streamed upload as a
 * public, CDN-reachable file owned by the resolved federated user — the SAME
 * service-token flow that already mirrors federated post media and the avatar
 * (downloaded server-side by oxy-api). It deliberately does NOT use the SDK's
 * `uploadProfileBanner`, which routes through the USER-authenticated
 * `POST /assets/upload` and is rejected `401 UNAUTHORIZED` on the service client,
 * so the banner was never stored.
 *
 * Best-effort: returns `{ ok: true }` when the banner was stored, otherwise
 * `{ ok: false, permanent }`. `permanent` distinguishes a transient failure
 * (bad service credential, upstream 5xx, upload rejection — worth retrying) from
 * a permanently-unavailable banner (dead/oversized/non-image — never retry), so
 * the backfill caller can decide whether to back off and retry. A non-http url is
 * `permanent: true` (it will never become valid). Transient failures are surfaced
 * at `warn`; permanent ones stay quiet, mirroring `materializeFederatedMedia`.
 *
 * Shared by the live actor-resolution path (`resolveOxyExternalUser`, which
 * ignores the result) and the one-shot `backfillFederatedBanners` script (which
 * inspects `permanent` to drive retry) so both go through ONE implementation.
 */
export interface MirrorBannerResult {
  ok: boolean;
  permanent: boolean;
}

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
    const result = await persistRemoteMediaForFederatedOwnerDetailed(bannerUrl, oxyUserId, {
      role: 'banner',
      actorUri,
      remoteHost,
    });

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
      logger.warn(`Failed to mirror banner for ${actorUri}`, {
        reason: result.reason,
        remoteHost,
      });
    }

    return { ok: false, permanent: result.permanent };
  } catch (bannerErr) {
    // Honor the documented best-effort contract: a throw from the media persist or
    // the `UserSettings` write must never propagate. On the live resolution path it
    // would otherwise reach `resolveOxyExternalUser`'s outer catch and discard an
    // already-successful user resolution. Treat it as a transient (retryable)
    // failure so the backfill still retries, and swallow it.
    logger.warn(`Failed to mirror banner for ${actorUri}`, {
      error: bannerErr,
      remoteHost,
    });
    return { ok: false, permanent: false };
  }
}
