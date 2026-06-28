import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useUserByUsername, queryKeys } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { useAppearanceStore, type UserAppearance, type ProfileMedia } from '@/store/appearanceStore';
import { APP_COLOR_PRESETS, HEX_TO_APP_COLOR } from '@oxyhq/bloom/theme';
import type { Community } from '@/components/Profile/types';

const PROFILE_STALE_TIME = 5 * 60 * 1000; // 5 minutes
const PROFILE_GC_TIME = 30 * 60 * 1000; // 30 minutes

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
  isFollowPending?: boolean;
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
    displayName: profile.name.displayName,
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
  const federatedQuery = useQuery<User | null>({
    queryKey: [...queryKeys.users.details(), 'resolve', handle],
    queryFn: () => oxyServices.resolveProfile(handle),
    enabled: isFederated && handle.length > 0,
    staleTime: PROFILE_STALE_TIME,
    gcTime: PROFILE_GC_TIME,
  });

  const profile = (isFederated ? federatedQuery.data : localQuery.data) ?? null;
  const isPending = isFederated ? federatedQuery.isPending : localQuery.isPending;
  const isError = isFederated ? federatedQuery.isError : localQuery.isError;

  // Appearance/customization (privacy, cover image, post count, color overrides).
  // Driven by React Query so it dedupes and avoids a manual effect. The
  // appearance store caches the result for synchronous reads elsewhere.
  //
  // `viewerId` is part of the query key because the appearance payload carries
  // viewer-dependent fields (`followsYou`, and privacy-gated visibility). On
  // cold boot the viewer's session resolves ~5s after mount, so without the
  // viewer in the key these fields would stay frozen at their anonymous value.
  // The profile/federated queries above stay viewer-independent, so public
  // profile viewing is unaffected; only the relationship-aware appearance data
  // refetches when the viewer identity lands.
  const userId = profile?.id ?? '';
  const loadForUser = useAppearanceStore((state) => state.loadForUser);
  const appearanceQuery = useQuery<UserAppearance | null>({
    queryKey: ['appearance', 'user', userId, 'viewer', viewerId],
    queryFn: () => loadForUser(userId, true),
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
      followsYou: appearance?.followsYou,
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
