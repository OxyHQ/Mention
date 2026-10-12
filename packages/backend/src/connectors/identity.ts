import { logger } from '../utils/logger';
import { getDb } from '../db/postgres';
import {
  assertFederatedMediaUsable,
  enqueueFederatedMediaDeletions,
  FederatedMediaGoneError,
} from '../db/federation/mediaDeletionRepository';
import { userSettings } from '../db/schema/userProfile';
import { eq } from 'drizzle-orm';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { updateUserSettings } from '../db/userProfile/userSettingsRepository';
import { invalidate as invalidateUserSummaryCache } from '../services/userSummaryCache';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../services/mediaCache/cacheWorker';
import { FEDERATED_BANNER_DOWNLOAD_POLICY } from '../services/mediaCache/policy';
import { isAbsoluteHttpUrl, getRemoteHost } from './shared/url';
import type { NormalizedExternalActor } from '@oxy.so/federation';
import {
  createIdentityBridge,
  type ServiceRequest,
  type ServiceRequestMethod,
} from '@oxy.so/federation/node';
import { resolveOxyIdentity } from './oxyIdentity';
import { recordFederatedBannerInBackground } from '../db/federation/bannerMirrorRepository';

/** Oxy owns discovery and profiles; this module exposes Mention's transport adapter. */

/** Service-scoped oxy-api request, resolved at call time (the client is per-request). */
const callOxyService: ServiceRequest = <T>(
  method: ServiceRequestMethod,
  path: string,
  body?: unknown,
): Promise<T> => getServiceOxyClient().serviceRequest<T>(method, path, body);

const identityBridge = createIdentityBridge({
  makeServiceRequest: callOxyService,
  logger: {
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
  },
});

/** Resolve only transport coordinates; Oxy independently verifies identity and profile fields. */
export async function resolveOxyExternalUser(
  actor: NormalizedExternalActor,
): Promise<string | null> {
  try {
    const resolved = await resolveOxyIdentity({
      actorUri: actor.externalId,
      transportAcct: actor.handle,
      // The actor's own network IS the protocol Oxy resolves it through — no
      // longer "atproto, else ActivityPub": an `instagram-graph` actor is neither.
      protocol: actor.network,
    });
    await invalidateUserSummaryCache([resolved.user.id]);
    // The banner is Mention's own (`user_settings.profile_header_image`), not
    // Oxy's: record the URL the source advertises so the banner sweep mirrors
    // it (a write only when it changed; never awaited, never fails the resolve).
    recordFederatedBannerInBackground({
      oxyUserId: resolved.user.id,
      actorUri: actor.externalId,
      bannerUrl: actor.bannerUrl,
    });
    return resolved.user.id;
  } catch (err) {
    logger.warn('[FedSync] Oxy identity resolution failed', { actor: actor.externalId, err });
    return null;
  }
}

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
  /** Why it failed, short and non-sensitive (`not-media`, `upstream-error:503`, …). */
  reason?: string;
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
 * Unlike post media it passes `FEDERATED_BANNER_DOWNLOAD_POLICY`: a raster image
 * only, downloaded up to `FEDERATED_BANNER_DOWNLOAD_MAX_BYTES`. A banner is a
 * still image, and a remote actor advertising a video as its `image` must not
 * turn into a video-sized mirror.
 *
 * The download decides what the banner IS from its bytes, never the declared
 * Content-Type, and stores an oversized, animated or non-web-format banner as a
 * re-encoded first-frame still instead of dropping it (see the policy).
 *
 * Best-effort: returns `{ ok: true }` when the banner was stored, otherwise
 * `{ ok: false, permanent, reason }`. A non-http url is `permanent: true`.
 * Transient failures are surfaced at `warn`; permanent ones stay quiet. Called
 * by the banner sweep (`services/federatedBannerMirror.ts`), which records the
 * outcome and retries — `permanent` only chooses how soon.
 */
export async function mirrorFederatedBanner(
  bannerUrl: string,
  oxyUserId: string,
  actorUri: string,
): Promise<MirrorBannerResult> {
  if (!isAbsoluteHttpUrl(bannerUrl)) {
    return { ok: false, permanent: true, reason: 'not-http' };
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
      // A banner can share its file with a post image (Oxy dedupes by content
      // hash), so it takes the same per-file lock and tombstone check a post's
      // media does before it starts referencing the id.
      const bannerFileId = result.media.oxyFileId;
      try {
        await getDb().transaction(async (tx) => {
          await assertFederatedMediaUsable(tx, [bannerFileId]);
          const [previous] = await tx
            .select({ banner: userSettings.profileHeaderImage })
            .from(userSettings)
            .where(eq(userSettings.oxyUserId, oxyUserId));
          await updateUserSettings(oxyUserId, { set: { profileHeaderImage: bannerFileId } }, tx);
          // The REPLACED banner is a re-hosted federated file nothing may need
          // any more: queue it (the drain re-checks references first).
          if (previous?.banner && previous.banner !== bannerFileId) {
            await enqueueFederatedMediaDeletions([previous.banner], tx);
          }
        });
      } catch (err) {
        if (err instanceof FederatedMediaGoneError)
          return { ok: false, permanent: false, reason: 'file-being-deleted' };
        throw err;
      }
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

    return {
      ok: false,
      permanent: result.permanent,
      reason: result.status ? `${result.reason}:${result.status}` : result.reason,
    };
  } catch (bannerErr) {
    // Honor the documented best-effort contract: a throw from the media persist or
    // the `UserSettings` write must never propagate. Treat it as a transient
    // (retryable) failure so the backfill still retries, and swallow it.
    logger.warn('Failed to mirror federated actor banner', {
      error: bannerErr,
      remoteHost,
    });
    return { ok: false, permanent: false, reason: 'error' };
  }
}
