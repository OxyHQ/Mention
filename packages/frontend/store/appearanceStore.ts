import { create } from 'zustand';
import { api, publicApi, isUnauthorizedError } from '@/utils/api';
import { queryClient } from '@/lib/queryClient';
import type { ThemeMode } from '@oxyhq/bloom/theme';

function unwrapApiData<T>(value: T | { data: T } | null | undefined): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    const recordValue = value as Record<string, unknown>;
    if ('data' in recordValue) {
      const inner = recordValue.data as T | null | undefined;
      return inner ?? null;
    }
  }

  return value as T;
}

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
}

/**
 * A Syra track pinned to the profile (Instagram-style "profile song"). The
 * metadata is denormalized and preview-verified server-side at save time, so the
 * public profile-design payload carries it ready to render and play as-is.
 */
export interface ProfileSong {
  syraTrackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  previewUrl: string;
  startSec: number;
  durationSec?: number;
}

/**
 * The untrusted reference the owner submits when pinning a song. The server
 * resolves the canonical metadata + preview URL from the Syra catalog and clamps
 * `startSec`, so the client only sends the track id and the chosen start offset.
 */
export interface ProfileSongInput {
  syraTrackId: string;
  startSec: number;
}

export interface UserAppearance {
  oxyUserId: string;
  postsCount?: number;
  boostsCount?: number;
  repliesCount?: number;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  profileCustomization?: {
    coverPhotoEnabled?: boolean;
    minimalistMode?: boolean;
  };
  /**
   * Pinned profile song. The public profile-design DTO exposes it as a top-level
   * field (denormalized + preview-verified server-side); `null`/absent means the
   * user has not set one.
   */
  profileSong?: ProfileSong | null;
  followsYou?: boolean;
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  interests?: {
    tags?: string[];
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface UserAppearanceUpdate {
  appearance?: Partial<AppearanceSettings>;
  profileHeaderImage?: string | null;
  profileCustomization?: UserAppearance['profileCustomization'];
  /** `ProfileSongInput` to pin/replace the song, or `null` to remove it. */
  profileSong?: ProfileSongInput | null;
  interests?: UserAppearance['interests'];
}

interface AppearanceStore {
  mySettings: UserAppearance | null;
  byUserId: Record<string, UserAppearance>;
  loading: boolean;
  error: string | null;
  loadMySettings: (isAuthenticated: boolean) => Promise<void>;
  loadForUser: (userId: string, forceRefresh?: boolean) => Promise<UserAppearance | null>;
  updateMySettings: (partial: UserAppearanceUpdate) => Promise<UserAppearance | null>;
  reset: () => void;
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => ({
  mySettings: null,
  byUserId: {},
  loading: false,
  error: null,

  async loadMySettings(isAuthenticated: boolean) {
    if (!isAuthenticated) {
      return;
    }

    try {
      set({ loading: true, error: null });

      const res = await api.get<UserAppearance>('profile/settings/me');
      const doc = unwrapApiData<UserAppearance>(res.data);

      if (doc) {
        set((state) => ({
          mySettings: doc,
          byUserId: doc.oxyUserId ? { ...state.byUserId, [doc.oxyUserId]: doc } : state.byUserId,
          loading: false,
        }));
      } else {
        set({ loading: false });
      }
    } catch (e: unknown) {
      if (isUnauthorizedError(e)) {
        set({ loading: false, error: null });
        return;
      }
      const message = e instanceof Error ? e.message : 'Failed to load settings';
      set({ loading: false, error: message });
    }
  },

  async loadForUser(userId: string, forceRefresh: boolean = false) {
    if (!userId) return null;

    try {
      const cached = get().byUserId[userId];
      if (cached && !forceRefresh) return cached;

      const res = await publicApi.get<UserAppearance>(`profile/design/${userId}`);
      const doc = unwrapApiData<UserAppearance>(res.data);

      if (doc) {
        set((state) => ({
          byUserId: { ...state.byUserId, [userId]: doc },
        }));
      }

      return doc ?? null;
    } catch {
      return null;
    }
  },

  async updateMySettings(partial: UserAppearanceUpdate) {
    try {
      set({ loading: true, error: null });

      const payload: UserAppearanceUpdate = {
        ...(partial.appearance && { appearance: partial.appearance }),
        ...(Object.prototype.hasOwnProperty.call(partial, 'profileHeaderImage') && {
          profileHeaderImage: partial.profileHeaderImage,
        }),
        ...(partial.profileCustomization && {
          profileCustomization: partial.profileCustomization,
        }),
        // `profileSong` accepts `null` (remove), so gate on key presence rather
        // than truthiness. The server resolves canonical metadata + preview URL.
        ...(Object.prototype.hasOwnProperty.call(partial, 'profileSong') && {
          profileSong: partial.profileSong,
        }),
        ...(partial.interests && {
          interests: partial.interests,
        }),
      };

      const res = await api.put<UserAppearance>('profile/settings', payload);
      const doc = unwrapApiData<UserAppearance>(res.data);

      if (doc) {
        set((state) => ({
          mySettings: doc,
          byUserId: doc.oxyUserId ? { ...state.byUserId, [doc.oxyUserId]: doc } : state.byUserId,
          loading: false,
        }));

        // `useProfileData` reads this same appearance payload through React Query
        // (`['appearance', 'user', <userId>, 'viewer', <viewerId>]`) to render the
        // profile banner, accent color, and customization. The store update above
        // does NOT touch that cache, so without this invalidation the viewer's own
        // profile would keep rendering the pre-edit banner/color until the 5-minute
        // staleTime elapses or a full reload. Invalidate every viewer variant for
        // this owner so the profile screen refetches the fresh appearance.
        if (doc.oxyUserId) {
          queryClient.invalidateQueries({ queryKey: ['appearance', 'user', doc.oxyUserId] });
        }

        return doc;
      }

      set({ loading: false });
      return null;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to update settings';
      set({ loading: false, error: message });
      return null;
    }
  },

  reset() {
    set({ mySettings: null, byUserId: {}, loading: false, error: null });
  },
}));
