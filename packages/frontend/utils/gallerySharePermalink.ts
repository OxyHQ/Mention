import { getNormalizedUserHandle } from '@oxy.so/core';
import { profileBasePath, type ProfileRouteFamily } from '@/components/Profile/profileRoute';
import { WEB_BASE_URL } from '@/config';
import { postPermalink } from '@/utils/postPermalink';

/**
 * The profile screen must pass the resolved Oxy username, never a transport
 * handle or an inferred username/instance combination. The route family comes
 * from that same resolved account.
 */
export function galleryProfilePermalink(
  canonicalUsername: string | null | undefined,
  family: ProfileRouteFamily,
): string | undefined {
  const handle = getNormalizedUserHandle({ username: canonicalUsername });
  if (!handle) return undefined;
  try {
    const path = profileBasePath(family, encodeURIComponent(handle));
    return `${WEB_BASE_URL.replace(/\/$/, '')}${path}`;
  } catch {
    return undefined;
  }
}

/** A post link names the post and leaves its authorization to the server. */
export function galleryPostPermalink(postId: string | null | undefined): string | undefined {
  if (!postId?.trim()) return undefined;
  try {
    return postPermalink(encodeURIComponent(postId));
  } catch {
    return undefined;
  }
}
