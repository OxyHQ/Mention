import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@oxyhq/services';
import { logger } from '@/lib/logger';
import { useUsersStore, useUserByUsername } from '@/stores/usersStore';
import { useAppearanceStore } from '@/store/appearanceStore';
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
 * Resolves fediverse handles via OxyHQServices (WebFinger → actor fetch → upsert).
 */
const federatedProfileCache = new Map<string, { user: any; fetchedAt: number }>();
const FEDERATED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function useFederatedProfileData(handle: string): {
  data: ProfileData | null;
  loading: boolean;
  error: boolean;
} {
  const { oxyServices } = useAuth();
  const cached = handle ? federatedProfileCache.get(handle) : undefined;
  const [user, setUser] = useState<any>(cached?.user || null);
  const [loading, setLoading] = useState(!cached?.user);
  const [error, setError] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;

    const cachedEntry = federatedProfileCache.get(handle);
    const isStale = !cachedEntry || Date.now() - cachedEntry.fetchedAt > FEDERATED_CACHE_TTL;

    if (cachedEntry?.user && !fetchedRef.current) {
      setUser(cachedEntry.user);
      setLoading(false);
      setError(false);
    }

    if (!isStale) return;
    if (!cachedEntry?.user) setLoading(true);

    (async () => {
      try {
        const result = await oxyServices.resolveProfile(handle);
        if (!cancelled) {
          setUser(result);
          setError(!result);
          if (result) {
            federatedProfileCache.set(handle, { user: result, fetchedAt: Date.now() });
          }
          fetchedRef.current = true;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [handle, oxyServices]);

  const profileData = useMemo((): ProfileData | null => {
    if (!user) return null;

    const nameValue = typeof user.name === 'string' ? user.name : user.name?.full || user.name?.first;

    return {
      id: user.id || handle,
      username: handle,
      bio: user.bio || user.description,
      verified: false,
      isFederated: true,
      actorUri: user.federation?.actorUri,
      instance: user.federation?.domain,
      followersCount: user._count?.followers ?? 0,
      followingCount: user._count?.following ?? 0,
      createdAt: user.createdAt,
      design: {
        displayName: nameValue || handle.split('@')[0],
        avatar: user.avatar,
        coverPhotoEnabled: false,
        minimalistMode: false,
      },
    };
  }, [user, handle]);

  return { data: profileData, loading, error };
}

/**
 * Unified hook for profile data that combines:
 * - Oxy profile data (from usersStore)
 * - Appearance/customization settings (from appearanceStore, which includes privacy)
 * - Federation data (for federated handles)
 *
 * Parallelizes profile + appearance fetches when user is cached.
 * Uses proper Zustand selectors to avoid unnecessary re-renders.
 */
export function useProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
  error: boolean;
} {
  // All profiles (local and federated) use the same code path.
  // The OxyHQ API resolves federated handles (user@domain) transparently
  // via WebFinger when they're not yet in the local DB.
  return useLocalProfileData(username);
}

/**
 * Hook for local (non-federated) profile data.
 */
function useLocalProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
  error: boolean;
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

  // Fetch profile and appearance data when username changes.
  // Parallelizes requests when user is already cached (common — primed from post feeds).
  // Skips the appearance network call if data was fetched recently.
  useEffect(() => {
    if (!username) return;

    let cancelled = false;

    const fetchProfile = async () => {
      try {
        const profileLoader = (u: string) => oxyServices.getProfileByUsername(u);

        // Check if user is already cached — if so, we know the ID and can
        // fire profile refresh + appearance fetch in parallel.
        const cachedId = useUsersStore.getState().idByUsername[username.toLowerCase()];

        if (cachedId) {
          // Only force-refresh appearance if we don't already have it cached.
          // loadForUser with forceRefresh=false returns cached data immediately
          // without a network call, while forceRefresh=true always hits the API.
          const hasAppearance = Boolean(useAppearanceStore.getState().byUserId[cachedId]);
          await Promise.all([
            ensureByUsername(username, profileLoader),
            loadForUser(cachedId, hasAppearance ? false : true),
          ]);
        } else {
          // Cold cache — must fetch profile first to get the ID,
          // then fire appearance as fire-and-forget (zustand selector picks it up).
          const data = await ensureByUsername(username, profileLoader);
          if (!cancelled && data?.id) {
            loadForUser(data.id, true);
          }
        }
      } catch (err) {
        logger.debug('Profile fetch error', { error: err });
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

    const federation = oxyProfile.federation as { actorUri?: string; domain?: string } | undefined;

    return {
      ...oxyProfile,
      id: oxyProfile.id || '',
      username: oxyProfile.username || '',
      postsCount: appearance?.postsCount,
      followsYou: appearance?.followsYou,
      isFederated: oxyProfile.isFederated || oxyProfile.type === 'federated',
      actorUri: oxyProfile.actorUri || federation?.actorUri,
      instance: oxyProfile.instance || federation?.domain,
      followersCount: oxyProfile._count?.followers ?? oxyProfile.followersCount ?? 0,
      followingCount: oxyProfile._count?.following ?? oxyProfile.followingCount ?? 0,
      design,
      privacy: appearance?.privacy,
    };
  }, [oxyProfile, appearance]);

  // Loading state: true if username provided but no profile data yet
  const loading = Boolean(username && !oxyProfile);

  return { data: profileData, loading, error: false };
}
