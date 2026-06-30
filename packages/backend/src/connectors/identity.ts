import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import UserSettings from '../models/UserSettings';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../services/mediaCache/cacheWorker';
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

    // Mirror the remote banner into a durable, PUBLIC Oxy asset, then store its
    // file id in Mention's per-user `UserSettings.profileHeaderImage` (the same
    // field a LOCAL user's banner uses, read back by the profile-design
    // endpoint). This reuses the canonical federated-media path
    // (`persistRemoteMediaForFederatedOwnerDetailed` →
    // `POST /assets/service/federation`): SSRF-safe download → streamed upload as
    // a public, CDN-reachable file owned by the resolved federated user — the
    // SAME service-token flow that already mirrors federated post media and the
    // avatar (downloaded server-side by oxy-api). It deliberately does NOT use the
    // SDK's `uploadProfileBanner`, which routes through the USER-authenticated
    // `POST /assets/upload` and is rejected `401 UNAUTHORIZED` on the service
    // client, so the banner was never stored.
    if (actor.bannerUrl && isAbsoluteHttpUrl(actor.bannerUrl)) {
      const result = await persistRemoteMediaForFederatedOwnerDetailed(actor.bannerUrl, oxyId, {
        role: 'banner',
        actorUri: actor.externalId,
        remoteHost: getRemoteHost(actor.bannerUrl),
      });
      if (result.ok) {
        await UserSettings.updateOne(
          { oxyUserId: oxyId },
          { $set: { profileHeaderImage: result.media.oxyFileId } },
          { upsert: true },
        );
      } else if (!result.permanent) {
        // Surface transient failures (bad service credential, upstream 5xx,
        // upload rejection) at `warn` — a silent `debug` previously hid a total
        // outage where 0 federated banners were ever stored. Permanently
        // unavailable banners (dead/oversized/non-image) are expected and stay
        // quiet, mirroring `materializeFederatedMedia`.
        logger.warn(`Failed to mirror banner for ${actor.externalId}`, {
          reason: result.reason,
          remoteHost: getRemoteHost(actor.bannerUrl),
        });
      }
    }

    return oxyId;
  } catch (resolveErr) {
    logger.warn(`Failed to resolve Oxy user for ${actor.externalId}:`, resolveErr);
    return null;
  }
}
