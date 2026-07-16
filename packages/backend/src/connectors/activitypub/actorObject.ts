import { logger } from '../../utils/logger';
import { resolveAvatarUrl, resolveMediaRef } from '../../utils/mediaResolver';
import {
  FEDERATION_DOMAIN,
  actorUrl,
  inboxUrl,
  outboxUrl,
  featuredUrl,
  followersUrl,
  followingUrl,
  sharedInboxUrl,
} from './constants';

/**
 * The single builder of a LOCAL user's ActivityPub `Person` actor document.
 *
 * Shared by the GET actor route (`ap.routes.ts`, which serves it as a standalone
 * JSON-LD document) and the outbound `Update(Person)` broadcast
 * (`FollowService.federateActorUpdate`, which embeds it in an `Update` activity),
 * so a follower's Mastodon renders the same actor whether it was fetched or
 * pushed. Deliberately does NOT include the top-level `@context`: the GET route
 * and the `Update` envelope each own their JSON-LD context, and an embedded actor
 * object must not double-declare it.
 */

/** Fields of the resolved Oxy user the actor document reads. */
export interface ActorUserView {
  _id?: string | null;
  id?: string | null;
  name?: { displayName?: string | null } | null;
  bio?: string | null;
  avatar?: string | null;
  createdAt?: string | null;
}

/** Map common image extensions to a MIME type for an actor image `mediaType`. */
const IMAGE_MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** True when `value` is an absolute `http(s)` URL. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    return /^https?:$/i.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Build an ActivityPub `Image` object from an already-absolute URL, deriving
 * `mediaType` from the URL extension when recognizable (a bare `Image` with a
 * `url` is spec-valid, so an unknown extension simply omits `mediaType` rather
 * than asserting a wrong one). Shared by the actor `icon` (avatar) and `image`
 * (profile banner) builders.
 */
function apImageObject(url: string): { type: 'Image'; url: string; mediaType?: string } {
  let extension: string | undefined;
  try {
    extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
  } catch {
    extension = url.split('?')[0]?.split('.').pop()?.toLowerCase();
  }
  const mediaType = extension ? IMAGE_MEDIA_TYPE_BY_EXT[extension] : undefined;
  return mediaType ? { type: 'Image', url, mediaType } : { type: 'Image', url };
}

/**
 * Build the actor `icon` (avatar) object for ActivityPub.
 *
 * The avatar reference stored on the Oxy user may be a raw Oxy file id (e.g.
 * `69b80c09a08af16d4b871195`) or an absolute URL. ActivityPub consumers such as
 * Mastodon validate that `icon.url` is an absolute URL and REJECT the entire
 * actor document when it is not — so a raw file id here makes the account
 * undiscoverable. We therefore resolve the reference through the same
 * server-authoritative `resolveAvatarUrl` mechanism the rest of the API uses
 * (Oxy file id → absolute Oxy asset stream URL; external URL → proxied through
 * our own origin), and only emit `icon` when that yields a real absolute URL.
 *
 * Returns undefined when there is no avatar or no absolute URL can be produced —
 * Mastodon is fine with an avatar-less actor, but a non-absolute url breaks it.
 */
export function buildActorIcon(avatar: string | null | undefined): { type: 'Image'; url: string; mediaType?: string } | undefined {
  if (!avatar) return undefined;

  // Resolve a raw Oxy file id (or external URL) to a final, absolute URL. If the
  // reference was already an absolute http(s) URL, `resolveAvatarUrl` returns an
  // absolute URL too (verbatim for our own origins, proxied for external CDNs).
  const resolved = resolveAvatarUrl(avatar);

  // Guard the absolute-URL invariant: if resolution failed or degraded to a
  // non-absolute passthrough (e.g. an unresolvable id), OMIT `icon` entirely
  // rather than emit a value that would make Mastodon reject the actor.
  if (!resolved || !isAbsoluteHttpUrl(resolved)) {
    logger.warn(`[Federation] Omitting actor icon — avatar did not resolve to an absolute URL (ref: ${avatar})`);
    return undefined;
  }

  return apImageObject(resolved);
}

/**
 * Build the actor `image` (profile banner/header) object for ActivityPub.
 *
 * Mastodon renders the AP `image` property as the profile HEADER banner — a
 * Mention user's banner is otherwise invisible across the fediverse. The banner
 * reference lives in Mention's own `UserSettings.profileHeaderImage` (a raw Oxy
 * file id or an absolute URL), the same field the profile-design endpoint reads
 * and `mirrorFederatedBanner` writes for the inbound direction. It is resolved
 * through the canonical media chokepoint (`resolveMediaRef`) to a final absolute
 * URL — an Oxy file id → CDN URL, an external URL → proxied through our origin —
 * mirroring {@link buildActorIcon}'s absolute-URL invariant.
 *
 * Returns undefined when there is no banner or none can be resolved to an
 * absolute URL, so callers omit the field cleanly.
 */
export function buildActorImage(banner: string | null | undefined): { type: 'Image'; url: string; mediaType?: string } | undefined {
  if (!banner) return undefined;

  const resolved = resolveMediaRef(banner).url;
  if (!resolved || !isAbsoluteHttpUrl(resolved)) {
    logger.warn(`[Federation] Omitting actor image — banner did not resolve to an absolute URL (ref: ${banner})`);
    return undefined;
  }

  return apImageObject(resolved);
}

/**
 * Assemble the LOCAL user's AP `Person` actor object (WITHOUT the top-level
 * `@context` — the caller owns that). `displayName` is the caller-resolved Oxy
 * `name.displayName` (falling back to the handle); it is never recomposed from
 * name parts here. The banner lives in Mention's own `UserSettings`, passed in as
 * `profileHeaderImage`.
 */
export function buildLocalActorObject(params: {
  username: string;
  displayName: string;
  bio?: string | null;
  avatar?: string | null;
  profileHeaderImage?: string | null;
  publicKey: { keyId: string; publicKeyPem: string };
  createdAt?: string | null;
}): Record<string, unknown> {
  const { username, displayName, bio, avatar, profileHeaderImage, publicKey, createdAt } = params;

  const actorObject: Record<string, unknown> = {
    id: actorUrl(username),
    type: 'Person',
    preferredUsername: username,
    name: displayName,
    summary: bio || '',
    url: `https://${FEDERATION_DOMAIN}/@${username}`,
    inbox: inboxUrl(username),
    outbox: outboxUrl(username),
    featured: featuredUrl(username),
    followers: followersUrl(username),
    following: followingUrl(username),
    endpoints: { sharedInbox: sharedInboxUrl() },
    discoverable: true,
    manuallyApprovesFollowers: false,
    icon: buildActorIcon(avatar),
    image: buildActorImage(profileHeaderImage),
    publicKey: {
      id: publicKey.keyId,
      owner: actorUrl(username),
      publicKeyPem: publicKey.publicKeyPem,
    },
  };

  // `published` (account creation date) is advertised when the API provides it.
  if (createdAt) {
    actorObject.published = new Date(createdAt).toISOString();
  }

  return actorObject;
}
