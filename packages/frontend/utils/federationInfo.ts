import { getNormalizedUserHandle } from '@oxy.so/core';
import type { ExternalNetwork } from '@/services/feedService';

/**
 * Bluesky's canonical network domain — an atproto account's `instance` is ALWAYS
 * this (a Bluesky handle is a whole DNS name, not a `local@host` address), so it
 * is the reliable discriminator between an ActivityPub (Mastodon, …) actor and a
 * Bluesky (atproto) one. Mirrors the backend `BSKY_NETWORK_DOMAIN` constant.
 */
export const BLUESKY_NETWORK_DOMAIN = 'bsky.social';

/**
 * Instagram's network domain. An account whose identity is `<u>@instagram.com`
 * is an Instagram account whichever road its posts take — the kilogram.makeup
 * ActivityPub bridge or Meta's Graph API (`instagram-graph:<id>` actor) — so the
 * About screen names Instagram and links to the account's instagram.com page.
 */
const INSTAGRAM_NETWORK_DOMAIN = 'instagram.com';

/** Instagram usernames: letters, digits, `.` and `_`, at most 30. */
const INSTAGRAM_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

/** What the About screen says about where a federated account lives. */
export interface FederationInfo {
  network: ExternalNetwork;
  instance?: string;
  handle?: string | null;
  /** A web-openable URL of the account's ORIGINAL profile, when one exists. */
  originalProfileUrl: string | null;
}

/**
 * Federation identity for the About screen's Fediverse section (federated
 * profiles only, every network): the network, the canonical `@user@domain`
 * handle, and a web-openable URL to the ORIGINAL profile. A Mastodon actor URL
 * redirects a browser GET to the human-readable profile; an atproto DID / handle
 * resolves on bsky.app's `/profile/<id>` route; an Instagram identity links to
 * its instagram.com page. Pure, so every branch is testable without the screen.
 */
export function federationInfoOf(
  profile: { isFederated?: boolean; actorUri?: string; instance?: string; username?: string } | null | undefined,
): FederationInfo | null {
  if (!profile?.isFederated) return null;
  const actorUri = profile.actorUri;
  const instance = profile.instance;
  const isBluesky =
    instance === BLUESKY_NETWORK_DOMAIN ||
    (actorUri?.startsWith('did:') ?? false) ||
    (actorUri?.startsWith('at://') ?? false);
  const isInstagram =
    instance?.toLowerCase() === INSTAGRAM_NETWORK_DOMAIN ||
    (actorUri?.startsWith('instagram-graph:') ?? false);
  const network: ExternalNetwork = isBluesky ? 'atproto' : isInstagram ? 'instagram-graph' : 'activitypub';
  const handle = getNormalizedUserHandle({
    username: profile.username,
    instance,
    isFederated: true,
  });

  let originalProfileUrl: string | null = null;
  if (isInstagram) {
    // The Instagram page, never the bridge's actor URL: the bridge serves an
    // ActivityPub document, and the Graph actor URI is not a web address.
    const at = handle?.lastIndexOf('@') ?? -1;
    const username = handle && at > 0 ? handle.slice(0, at) : undefined;
    originalProfileUrl = username && INSTAGRAM_USERNAME_RE.test(username)
      ? `https://www.instagram.com/${username}/`
      : null;
  } else if (actorUri?.startsWith('https://') || actorUri?.startsWith('http://')) {
    originalProfileUrl = actorUri;
  } else if (isBluesky && actorUri) {
    // bsky.app resolves both DIDs and handles at `/profile/<id>`.
    const id = actorUri.startsWith('at://') ? actorUri.slice('at://'.length).split('/')[0] : actorUri;
    originalProfileUrl = id ? `https://bsky.app/profile/${id}` : null;
  }

  return { network, instance, handle, originalProfileUrl };
}
