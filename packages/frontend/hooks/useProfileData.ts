import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useUserByUsername, queryKeys } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { useAppearanceStore, type UserAppearance, type ProfileMedia } from '@/store/appearanceStore';
import { APP_COLOR_PRESETS, HEX_TO_APP_COLOR } from '@oxyhq/bloom/theme';
import type { Community } from '@/components/Profile/types';
import { displayNameOrHandle } from '@/utils/displayName';

const PROFILE_STALE_TIME = 5 * 60 * 1000; // 5 minutes
const PROFILE_GC_TIME = 30 * 60 * 1000; // 30 minutes

/**
 * React Query key for a federated profile resolved via WebFinger. Mention-owned
 * — the SDK has no by-handle federated-resolve hook, so there is no
 * `queryKeys.users.*` helper for it — but it is rooted at the SDK's
 * `queryKeys.users.details()` so it lives in the users-cache namespace and is
 * cleared alongside the SDK user keys. Viewer-scoped for the same reason as
 * `useUserByUsername`: an authenticated resolve embeds the viewer-relative
 * `relationship` (`followsYou`), so anon vs authed must be distinct entries and
 * a landing session must force a refetch. Defined once here so this Mention-only
 * key has a single source of truth and can never drift from its reader.
 */
export function federatedProfileQueryKey(handle: string, viewerId: string): readonly unknown[] {
  return [...queryKeys.users.details(), 'resolve', handle, 'viewer', viewerId];
}

export interface ProfileDesign {
  displayName: string;
  bannerUrl?: string;
  avatar?: string;
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
  color?: string;
  /** Pinned Syra profile media — a song XOR a podcast — when the user has set one (and the viewer has access). */
  profileMedia?: ProfileMedia;
}

export interface ProfileData {
  id: string;
  username: string;
  name: User['name'];
  bio?: string;
  verified?: boolean;
  avatar?: string;
  color?: string;
  createdAt?: string;
  updatedAt?: string;
  postsCount?: number;
  boostsCount?: number;
  repliesCount?: number;
  followsYou?: boolean;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  isFollowing?: boolean;
  instance?: string;
  actorUri?: string;
  followersCount?: number;
  followingCount?: number;
  primaryLocation?: string;
  verifiedAt?: string;
  usernameChangeCount?: number;
  connectedVia?: string;
  links?: User['links'];
  linksMetadata?: User['linksMetadata'];
  fields?: Array<{
    name?: string;
    value?: string;
    verifiedAt?: string;
  }>;
  communities?: Community[];
  federation?: {
    actorUri?: string;
    domain?: string;
  };
  design: ProfileDesign;
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  // ProfileData spreads the full Oxy `User` plus arbitrary backend fields that
  // many consumers read positionally (links, joined date, communities, etc.).
  // Keep this permissive to preserve those existing call sites unchanged.
  [key: string]: unknown;
}

/**
 * Computes profile design values from the Oxy profile + backend customization.
 */
function computeDesign(
  profile: User,
  appearance: UserAppearance | null | undefined,
): ProfileDesign {
  const presetColor =
    typeof profile.color === 'string' && profile.color in APP_COLOR_PRESETS
      ? profile.color
      : undefined;

  return {
    displayName: displayNameOrHandle(profile.name.displayName, profile.username),
    bannerUrl: appearance?.profileHeaderImage,
    avatar: profile.avatar ?? undefined,
    coverPhotoEnabled: appearance?.profileCustomization?.coverPhotoEnabled ?? true,
    minimalistMode: appearance?.profileCustomization?.minimalistMode ?? false,
    color:
      presetColor ||
      HEX_TO_APP_COLOR[appearance?.appearance?.primaryColor ?? ''] ||
      'blue',
    // The public design DTO normalizes "no media" to `null`/absent.
    profileMedia: appearance?.profileMedia ?? undefined,
  };
}

/**
 * Unified hook for profile data. Combines:
 * - The Oxy profile (React Query — the single in-memory actor cache).
 * - Appearance/customization settings (HTTP-backed appearance store, works web + native).
 * - Federation data (federated handles resolved server-side via WebFinger).
 *
 * Local handles (`username`) resolve via the SDK's `useUserByUsername`.
 * Federated handles (`user@domain`) resolve via `oxyServices.resolveProfile`,
 * which performs WebFinger discovery and returns `User | null` (never throws).
 */
export function useProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
  error: boolean;
} {
  const { oxyServices, user } = useAuth();
  const viewerId = user?.id ?? '';

  const handle = username ?? '';
  const isFederated = handle.includes('@');

  // Local profiles — SDK hook, shares the singleton React Query cache.
  const localQuery = useUserByUsername(isFederated ? null : handle || null);

  // Federated profiles — server-side WebFinger resolution.
  //
  // `viewerId` is part of the key for the same reason as the local
  // `useUserByUsername` hook: an authenticated profile fetch embeds the
  // viewer-relative `relationship` (`followsYou`), while an anonymous cold-boot
  // fetch omits it. Without the viewer in the key, react-query would freeze the
  // first anonymous copy and never refetch when the session lands ~5-25s later,
  // so the "Follows you" tag would flash then vanish forever. Adding the viewer
  // makes anon vs authed distinct entries AND forces a refetch when the session
  // resolves or the account switches — identical to the local path.
  const federatedQuery = useQuery<User | null>({
    queryKey: federatedProfileQueryKey(handle, viewerId),
    queryFn: () => oxyServices.resolveProfile(handle),
    enabled: isFederated && handle.length > 0,
    staleTime: PROFILE_STALE_TIME,
    gcTime: PROFILE_GC_TIME,
  });

  const profile = (isFederated ? federatedQuery.data : localQuery.data) ?? null;
  const isPending = isFederated ? federatedQuery.isPending : localQuery.isPending;
  const isError = isFederated ? federatedQuery.isError : localQuery.isError;

  // Appearance/customization (privacy, cover image, post count, color overrides).
  // Driven by React Query so it dedupes and avoids a manual effect — React Query
  // is the single authority for the foreign-profile design payload (the store's
  // `loadForUser` is now a plain fetcher and holds no per-user cache).
  //
  // `viewerId` is part of the query key because the appearance payload is
  // privacy-gated: a private / followers-only profile returns full design data
  // only to a follower and minimal data otherwise, so the same owner resolves to
  // different payloads per viewer. On cold boot the viewer's session resolves
  // ~5s after mount, so without the viewer in the key the gated data would stay
  // frozen at its anonymous value. The profile/federated queries above stay
  // viewer-independent, so public profile viewing is unaffected.
  const userId = profile?.id ?? '';
  const loadForUser = useAppearanceStore((state) => state.loadForUser);
  const appearanceQuery = useQuery<UserAppearance | null>({
    queryKey: ['appearance', 'user', userId, 'viewer', viewerId],
    queryFn: () => loadForUser(userId),
    enabled: userId.length > 0,
    staleTime: PROFILE_STALE_TIME,
    gcTime: PROFILE_GC_TIME,
  });
  const appearance = appearanceQuery.data ?? null;

  const profileData = useMemo<ProfileData | null>(() => {
    if (!profile) return null;

    const design = computeDesign(profile, appearance);
    const federation = profile.federation;
    const followersCount =
      profile._count?.followers ??
      (typeof profile.followersCount === 'number' ? profile.followersCount : 0);
    const followingCount =
      profile._count?.following ??
      (typeof profile.followingCount === 'number' ? profile.followingCount : 0);
    const communities = Array.isArray(profile.communities)
      ? profile.communities.flatMap((entry): Community[] => {
          if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
            const c = entry as { id?: string; name: string; description?: string; icon?: string; memberCount?: number };
            return [{ id: c.id, name: c.name, description: c.description, icon: c.icon, memberCount: c.memberCount }];
          }
          return [];
        })
      : undefined;

    return {
      ...profile,
      id: profile.id || '',
      communities,
      username: profile.username || '',
      avatar: profile.avatar ?? undefined,
      color: profile.color ?? undefined,
      postsCount: appearance?.postsCount,
      boostsCount: appearance?.boostsCount,
      repliesCount: appearance?.repliesCount,
      // "Follows you" now rides the Oxy profile fetch: `relationship` is populated
      // on authenticated single-profile fetches (absent for anon/self/bulk), so
      // `undefined` means "unknown", not "does not follow". No extra call and no
      // Mention-side computation — Oxy owns the follow graph.
      followsYou: profile.relationship?.followsYou,
      // Authoritative follow-button seed from the SAME authenticated fetch. The
      // app-root `getViewerGraph` seed is capped at 5000 follows and can lag on
      // cold boot, so a viewer who follows >5000 (or is mid-restore) would flash a
      // wrong "Follow" without this. `undefined` ⇒ unknown; the button then falls
      // back to the follow-store seed.
      isFollowing: profile.relationship?.isFollowing,
      isFederated: profile.isFederated || profile.type === 'federated',
      actorUri:
        (typeof profile.actorUri === 'string' ? profile.actorUri : undefined) ??
        federation?.actorUri,
      instance: profile.instance ?? federation?.domain,
      followersCount,
      followingCount,
      design,
      privacy: appearance?.privacy,
    };
  }, [profile, appearance]);

  // Loading while the query has not yet produced a value. Not-found
  // (resolved with no data) surfaces as an error so the UI can show its
  // empty state instead of an indefinite skeleton.
  const loading = Boolean(handle) && isPending;
  const error = isError || (Boolean(handle) && !isPending && !profile);

  return { data: profileData, loading, error };
}
