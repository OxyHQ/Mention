import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import UserSettings from '../models/UserSettings';
import { contentTypeFamily, fetchUpstreamFollowingRedirects } from '../utils/safeUpstreamFetch';
import { isAllowedMediaType } from '../services/mediaCache/mediaTypes';
import { readBoundedResponseBody } from './shared/httpBody';
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

/** Bounded timeout for the remote banner fetch (matches the prior inline value). */
const REMOTE_BANNER_FETCH_TIMEOUT_MS = 10000;

/** Maximum bytes accepted for a remote federated actor banner image. */
const ACTOR_BANNER_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Derive the federated user's instance domain from the normalized actor. AP
 * handles are `user@domain`; otherwise fall back to the host of the protocol id.
 * Reproduces the prior `domainFromAcct(acct) || actorHost` value for AP actors.
 *
 * For atproto the handle is itself a bare DNS name (e.g. `alice.bsky.social`) and
 * the protocol id is a `did:` (which has no URL host), so neither the `@` split
 * nor the URL host yields a domain — fall back to the handle (the domain).
 */
function deriveDomain(actor: NormalizedExternalActor): string {
  const at = actor.handle.lastIndexOf('@');
  if (at > 0 && at < actor.handle.length - 1) {
    return actor.handle.slice(at + 1).toLowerCase();
  }
  try {
    const host = new URL(actor.externalId).hostname.toLowerCase();
    if (host) return host;
  } catch {
    // Unparseable protocol id (e.g. a DID) — fall through to the handle.
  }
  return actor.handle.toLowerCase();
}

/**
 * Resolve/mint the Oxy user a normalized external actor maps to.
 *
 * Upserts the federated user via `PUT /users/resolve` (service-token scoped) so
 * profile changes (avatar, name, bio) stay synced — creating the user when it
 * does not exist. Returns the resolved Oxy user id, or `null` when Oxy is
 * unreachable / returns no id (callers must then skip, never persisting an
 * orphan). After resolution, the actor's banner is mirrored into Oxy through the
 * shared SSRF-safe upstream fetcher (best-effort; failures are logged, not
 * propagated).
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
    const domain = deriveDomain(actor);
    const oxyUser: { _id?: string; id?: string } | null = await oxyClient.makeServiceRequest('PUT', '/users/resolve', {
      type: 'federated',
      username: actor.handle,
      actorUri: actor.externalId,
      domain,
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

    // Download and upload the remote banner to Oxy (same pattern as avatar), but
    // only through the shared SSRF-safe upstream fetcher: it validates the
    // original URL and every redirect hop, pins DNS, and applies timeouts.
    if (actor.bannerUrl) {
      try {
        const deadline = AbortSignal.timeout(REMOTE_BANNER_FETCH_TIMEOUT_MS);
        const { response: imgRes } = await fetchUpstreamFollowingRedirects(actor.bannerUrl, {}, deadline);
        if ((imgRes.statusCode ?? 0) >= 200 && (imgRes.statusCode ?? 0) < 300) {
          const contentType = contentTypeFamily(imgRes.headers);
          if (!contentType.startsWith('image/') || !isAllowedMediaType(contentType)) {
            imgRes.destroy();
            throw new Error(`remote banner content-type not allowed: ${contentType || 'unknown'}`);
          }
          const buffer = await readBoundedResponseBody(imgRes, ACTOR_BANNER_MAX_BYTES);
          const blob = new Blob([buffer], { type: contentType });
          const asset = await oxyClient.uploadProfileBanner(blob, oxyId);
          const fileId = asset?.file?.id;
          if (fileId) {
            await UserSettings.updateOne(
              { oxyUserId: oxyId },
              { $set: { profileHeaderImage: fileId } },
              { upsert: true },
            );
          }
        } else {
          imgRes.destroy();
        }
      } catch (bannerErr) {
        logger.debug(`Failed to sync banner for ${actor.externalId}:`, bannerErr);
      }
    }

    return oxyId;
  } catch (resolveErr) {
    logger.warn(`Failed to resolve Oxy user for ${actor.externalId}:`, resolveErr);
    return null;
  }
}
