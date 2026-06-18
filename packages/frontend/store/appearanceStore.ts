import { create } from 'zustand';
import { api, publicApi, isUnauthorizedError } from '@/utils/api';
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
    displayName?: string;
  };
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
