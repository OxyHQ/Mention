import { create } from 'zustand';
import { api, publicApi, isUnauthorizedError } from '@/utils/api';
import { Storage } from '@/utils/storage';

const APPEARANCE_CACHE_KEY = 'oxy_appearance_settings';

function unwrapApiData<T>(value: T | { data: T } | null | undefined): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    const recordValue = value as Record<string, any>;
    if ('data' in recordValue) {
      const inner = recordValue.data as T | null | undefined;
      return inner ?? null;
    }
  }

  return value as T;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
}

export interface UserAppearance {
  oxyUserId: string;
  postsCount?: number;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  profileCustomization?: {
    coverPhotoEnabled?: boolean;
    minimalistMode?: boolean;
    displayName?: string;
    coverImage?: string;
  };
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  interests?: {
    tags?: string[];
  };
  createdAt?: string;
  updatedAt?: string;
}

interface AppearanceStore {
  mySettings: UserAppearance | null;
  byUserId: Record<string, UserAppearance>;
  loading: boolean;
  error: string | null;
  loadMySettings: () => Promise<void>;
  loadForUser: (userId: string, forceRefresh?: boolean) => Promise<UserAppearance | null>;
  updateMySettings: (partial: Partial<UserAppearance>) => Promise<UserAppearance | null>;
}

/**
 * Appearance store with optimized selectors to prevent unnecessary re-renders.
 * Always use selectors when subscribing: useAppearanceStore(state => state.mySettings)
 */
export const useAppearanceStore = create<AppearanceStore>((set, get) => ({
  mySettings: null,
  byUserId: {},
  loading: false,
  error: null,

  async loadMySettings() {
    try {
      set({ loading: true, error: null });
      
      // Load from cache first for instant theme application
      const cachedRaw = await Storage.get<UserAppearance | { data: UserAppearance }>(APPEARANCE_CACHE_KEY);
      const cached = unwrapApiData<UserAppearance>(cachedRaw);
      if (cached) {
        set({ mySettings: cached });
      }

      // Fetch fresh data from API
      const res = await api.get<UserAppearance>('profile/settings/me');
      const doc = unwrapApiData<UserAppearance>(res.data);
      
      // Cache the settings
      if (doc) {
        await Storage.set(APPEARANCE_CACHE_KEY, doc);

        set((state) => ({
          mySettings: doc,
          byUserId: doc.oxyUserId ? { ...state.byUserId, [doc.oxyUserId]: doc } : state.byUserId,
          loading: false,
        }));
      } else {
        set({ loading: false });
      }
    } catch (e: any) {
      if (isUnauthorizedError(e)) {
        set({ loading: false, error: null });
        return;
      }
      set({ loading: false, error: e?.message || 'Failed to load settings' });
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
    } catch (e) {
      return null;
    }
  },

  async updateMySettings(partial: Partial<UserAppearance>) {
    try {
      set({ loading: true, error: null });
      
      // Build payload with only allowed fields
      const payload: Partial<UserAppearance> = {
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
        // Update cache
        await Storage.set(APPEARANCE_CACHE_KEY, doc);

        set((state) => ({
          mySettings: doc,
          byUserId: doc.oxyUserId ? { ...state.byUserId, [doc.oxyUserId]: doc } : state.byUserId,
          loading: false,
        }));

        return doc;
      }

      set({ loading: false });
      return null;
    } catch (e: any) {
      set({ loading: false, error: e?.message || 'Failed to update settings' });
      return null;
    }
  },
}));
