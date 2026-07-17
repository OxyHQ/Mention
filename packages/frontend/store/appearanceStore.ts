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

/**
 * How much of a post's body text shows before truncating with a "read more"
 * link in feeds. Mention-only display preference; `all` disables in-feed
 * truncation. Maps to `previewChars` in `PostContentText`.
 */
export type PostTextExpand = 'default' | 'more' | 'muchMore' | 'all';

/** Behavior when tapping a truncated post's "Read more" link. */
export type PostReadMoreAction = 'openPost' | 'expandInline';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
  postTextExpand?: PostTextExpand;
  postReadMoreAction?: PostReadMoreAction;
  collapseLongBio?: boolean;
}

/**
 * A Syra track pinned to the profile (Instagram-style "profile song"). The
 * metadata is denormalized and preview-verified server-side at save time, so the
 * public profile-design payload carries it ready to render and play as-is.
 */
export interface ProfileSongMedia {
  type: 'song';
  syraTrackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  previewUrl: string;
  startSec: number;
  durationSec?: number;
}

/**
 * A Syra podcast show pinned to the profile (Threads-style card). Resolved and
 * denormalized server-side at save time; `showUrl` opens the show in Syra.
 */
export interface ProfilePodcastMedia {
  type: 'podcast';
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
  showUrl: string;
}

/**
 * A profile's pinned media — a Syra song OR a Syra podcast show, never both. The
 * single `profileMedia` field makes the two kinds structurally exclusive: setting
 * one replaces the other.
 */
export type ProfileMedia = ProfileSongMedia | ProfilePodcastMedia;

/**
 * The untrusted reference the owner submits when pinning media. The server
 * resolves canonical metadata + preview/show URLs from the Syra catalog (and
 * clamps `startSec` for songs), so the client only sends the catalog id (and the
 * chosen start offset for a song). Setting one kind replaces the other.
 */
export type ProfileMediaInput =
  | { type: 'song'; syraTrackId: string; startSec: number }
  | { type: 'podcast'; syraPodcastId: string };

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
   * Pinned profile media (song XOR podcast). The public profile-design DTO
   * exposes it as a top-level field (denormalized server-side); `null`/absent
   * means the user has not set one.
   */
  profileMedia?: ProfileMedia | null;
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
  /** `ProfileMediaInput` to pin/replace the media, or `null` to remove it. */
  profileMedia?: ProfileMediaInput | null;
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
        // `profileMedia` accepts `null` (remove), so gate on key presence rather
        // than truthiness. The server resolves canonical metadata + URLs and
        // returns the denormalized media on the design DTO (refetched via the
        // appearance-query invalidation below — we don't read it off this PUT).
        ...(Object.prototype.hasOwnProperty.call(partial, 'profileMedia') && {
          profileMedia: partial.profileMedia,
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
