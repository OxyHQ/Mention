import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useUserByUsername, queryKeys } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { useAppearanceStore, type UserAppearance } from '@/store/appearanceStore';
import { APP_COLOR_PRESETS, HEX_TO_APP_COLOR } from '@oxyhq/bloom/theme';

const PROFILE_STALE_TIME = 5 * 60 * 1000; // 5 minutes
const PROFILE_GC_TIME = 30 * 60 * 1000; // 30 minutes

export interface ProfileDesign {
  displayName: string;
  coverImage?: string;
  avatar?: string;
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
  color?: string;
}

export interface ProfileData {
  id: string;
  username: string;
  bio?: string;
  verified?: boolean;
  avatar?: string;
  postsCount?: number;
  boostsCount?: number;
  repliesCount?: number;
  followsYou?: boolean;
  isFederated?: boolean;
  instance?: string;
  followersCount?: number;
  followingCount?: number;
  design: ProfileDesign;
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  // ProfileData spreads the full Oxy `User` plus arbitrary backend fields that
  // many consumers read positionally (links, joined date, communities, etc.).
  // Keep this permissive to preserve those existing call sites unchanged.
  [key: string]: any;
}

/**
 * Computes profile design values from the Oxy profile + backend customization.
 */
function computeDesign(
  profile: User,
  appearance: UserAppearance | null | undefined,
): ProfileDesign {
  const customization = appearance?.profileCustomization;
  const nameValue =
    typeof profile.name === 'string' ? profile.name : profile.name?.full;

  const presetColor =
    typeof profile.color === 'string' && profile.color in APP_COLOR_PRESETS
      ? profile.color
      : undefined;

  return {
    displayName: customization?.displayName || nameValue || profile.username || '',
    coverImage: customization?.coverImage || appearance?.profileHeaderImage,
    avatar: profile.avatar,
    coverPhotoEnabled: customization?.coverPhotoEnabled ?? true,
    minimalistMode: customization?.minimalistMode ?? false,
    color:
      presetColor ||
      HEX_TO_APP_COLOR[appearance?.appearance?.primaryColor ?? ''] ||
      'blue',
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
  const { oxyServices } = useAuth();

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
  const userId = profile?.id ?? '';
  const loadForUser = useAppearanceStore((state) => state.loadForUser);
  const appearanceQuery = useQuery<UserAppearance | null>({
    queryKey: ['appearance', 'user', userId],
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

    return {
      ...profile,
      id: profile.id || '',
      username: profile.username || '',
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
