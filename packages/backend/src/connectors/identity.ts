import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { updateUserSettings } from '../db/userProfile/userSettingsRepository';
import { invalidate as invalidateUserSummaryCache } from '../services/userSummaryCache';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../services/mediaCache/cacheWorker';
import { FEDERATED_BANNER_DOWNLOAD_POLICY } from '../services/mediaCache/policy';
import { isAbsoluteHttpUrl, getRemoteHost } from './shared/url';
import { createIdentityBridge, type ServiceRequest, type ServiceRequestMethod } from '@oxyhq/federation/node';

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
      await updateUserSettings(oxyUserId, {
        set: { profileHeaderImage: result.media.oxyFileId },
      });
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
