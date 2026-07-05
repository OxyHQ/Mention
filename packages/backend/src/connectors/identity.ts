import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import UserSettings from '../models/UserSettings';
import {
  FEDERATED_BANNER_DOWNLOAD_POLICY,
  persistRemoteMediaForFederatedOwnerDetailed,
} from '../services/mediaCache/cacheWorker';
import { isAbsoluteHttpUrl, getRemoteHost } from './shared/url';
import type { NormalizedExternalActor } from './types';

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
  const result = await persistRemoteMediaForFederatedOwnerDetailed(
    bannerUrl,
    oxyUserId,
    {
      role: 'banner',
      actorUri,
      remoteHost,
    },
    { downloadPolicy: FEDERATED_BANNER_DOWNLOAD_POLICY },
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
    logger.warn(`Failed to mirror banner for ${actorUri}`, {
      reason: result.reason,
      remoteHost,
    });
  }

  return { ok: false, permanent: result.permanent };
}
