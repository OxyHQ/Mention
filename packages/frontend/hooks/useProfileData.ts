import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@oxyhq/services';
import { logger } from '@/lib/logger';
import { useUsersStore, useUserByUsername } from '@/stores/usersStore';
import { useAppearanceStore } from '@/store/appearanceStore';
import { usePrivacySettings } from './usePrivacySettings';
import { federationService } from '@/services/federationService';
import { APP_COLOR_PRESETS, HEX_TO_APP_COLOR } from '@oxyhq/bloom/theme';

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
  followsYou?: boolean;
  isFederated?: boolean;
  instance?: string;
  followersCount?: number;
  followingCount?: number;
  design: ProfileDesign;
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  [key: string]: any;
}

/**
 * Computes profile design values from Oxy profile + backend customization settings
 */
function computeDesign(
  oxyProfile: any,
  appearance: any
): ProfileDesign {
  if (!oxyProfile) {
    return {
      displayName: '',
      coverPhotoEnabled: true,
      minimalistMode: false,
    };
  }

  const customization = appearance?.profileCustomization;
  const nameValue = typeof oxyProfile?.name === 'string' 
    ? oxyProfile.name 
    : oxyProfile?.name?.full;

  return {
    displayName: customization?.displayName || nameValue || oxyProfile?.username || '',
    coverImage: customization?.coverImage || appearance?.profileHeaderImage,
    avatar: oxyProfile?.avatar,
    coverPhotoEnabled: customization?.coverPhotoEnabled ?? true,
    minimalistMode: customization?.minimalistMode ?? false,
    color: (oxyProfile?.color in APP_COLOR_PRESETS ? oxyProfile.color : undefined)
      || HEX_TO_APP_COLOR[appearance?.appearance?.primaryColor]
      || 'teal',
  };
}

/**
 * Check if a username is a federated handle (contains @ after stripping leading @).
 * e.g. "user@mastodon.social" → true, "localuser" → false
 */
function isFederatedUsername(username: string): boolean {
  return username.includes('@');
}

/**
 * Hook for federated profile data.
 * Fetches from federation service and maps to ProfileData.
 */
// Simple in-memory cache for federated profiles (stale-while-revalidate)
const federatedProfileCache = new Map<string, { actor: any; fetchedAt: number }>();
const FEDERATED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function useFederatedProfileData(handle: string): {
  data: ProfileData | null;
  loading: boolean;
} {
  const cached = handle ? federatedProfileCache.get(handle) : undefined;
  const [actor, setActor] = useState<any>(cached?.actor || null);
  const [loading, setLoading] = useState(!cached?.actor);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;

    const cachedEntry = federatedProfileCache.get(handle);
    const isStale = !cachedEntry || Date.now() - cachedEntry.fetchedAt > FEDERATED_CACHE_TTL;

    // Show cached data immediately (stale-while-revalidate)
    if (cachedEntry?.actor && !fetchedRef.current) {
      setActor(cachedEntry.actor);
      setLoading(false);
    }

    if (!isStale) return;

    if (!cachedEntry?.actor) setLoading(true);

    (async () => {
      try {
        const result = await federationService.lookupActor(handle);
        if (!cancelled) {
          setActor(result);
          if (result) {
            federatedProfileCache.set(handle, { actor: result, fetchedAt: Date.now() });
          }
          fetchedRef.current = true;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [handle]);

  const profileData = useMemo((): ProfileData | null => {
    if (!actor) return null;

    const username = handle.split('@')[0];
    const instance = handle.split('@')[1];

    return {
      id: actor.id || actor.actorUri || handle,
      username: handle,
      bio: actor.bio?.replace(/<[^>]*>/g, '') || undefined,
      verified: false,
      postsCount: actor.postsCount ?? 0,
      isFederated: true,
      actorUri: actor.actorUri,
      instance,
      isFollowing: actor.isFollowing,
      isFollowPending: actor.isFollowPending,
      followersCount: actor.followersCount ?? 0,
      followingCount: actor.followingCount ?? 0,
      fields: actor.fields,
      createdAt: actor.createdAt,
      memorial: actor.memorial,
      suspended: actor.suspended,
      actorType: actor.type,
      design: {
        displayName: actor.displayName || username,
        avatar: actor.avatarUrl || undefined,
        coverImage: actor.bannerUrl || undefined,
        coverPhotoEnabled: !!actor.bannerUrl,
        minimalistMode: false,
      },
    };
  }, [actor, handle]);

  return { data: profileData, loading };
}

/**
 * Unified hook for profile data that combines:
 * - Oxy profile data (from usersStore)
 * - Appearance/customization settings (from appearanceStore)
 * - Privacy settings
 * - Federation data (for federated handles)
 *
 * Uses proper Zustand selectors to avoid unnecessary re-renders
 */
export function useProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
} {
  const isFederated = Boolean(username && isFederatedUsername(username));

  // Federated path
  const fedResult = useFederatedProfileData(isFederated ? username! : '');

  // Local path
  const localResult = useLocalProfileData(isFederated ? undefined : username);

  return isFederated ? fedResult : localResult;
}

/**
 * Hook for local (non-federated) profile data.
 */
function useLocalProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
} {
  const { oxyServices } = useAuth();

  // Use existing hooks for store access
  const ensureByUsername = useUsersStore((state) => state.ensureByUsername);
  const loadForUser = useAppearanceStore((state) => state.loadForUser);

  // Get user from store using existing hook
  const oxyProfile = useUserByUsername(username);

  // Subscribe to appearance settings for this user
  const appearance = useAppearanceStore((state) => {
    const id = oxyProfile?.id;
    return id ? state.byUserId[id] : undefined;
  });

  // Load privacy settings
  const privacySettings = usePrivacySettings(oxyProfile?.id);

  // Fetch profile data when username changes
  useEffect(() => {
    if (!username) return;

    let cancelled = false;

    const fetchProfile = async () => {
      try {
        // Fetch fresh data - this will update the store
        const data = await ensureByUsername(
          username,
          (u) => oxyServices.getProfileByUsername(u)
        );

        if (!cancelled && data?.id) {
          // Load appearance settings for this user
          await loadForUser(data.id, true);
        }
      } catch (err) {
        logger.debug('Profile fetch error');
      }
    };

    fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [username, ensureByUsername, loadForUser, oxyServices]);

  // Compute unified profile data
  const profileData = useMemo((): ProfileData | null => {
    if (!oxyProfile) return null;

    const design = computeDesign(oxyProfile, appearance);

    // Use privacy from appearance data (from profileDesign endpoint) if available,
    // otherwise fall back to privacySettings hook (requires auth)
    // This ensures unauthenticated users can see privacy info
    const privacy = appearance?.privacy || privacySettings || undefined;

    return {
      ...oxyProfile,
      id: oxyProfile.id || '',
      username: oxyProfile.username || '',
      postsCount: appearance?.postsCount,
      followsYou: appearance?.followsYou,
      design,
      privacy,
    };
  }, [oxyProfile, appearance, privacySettings]);

  // Loading state: true if username provided but no profile data yet
  const loading = Boolean(username && !oxyProfile);

  return { data: profileData, loading };
}
