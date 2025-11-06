import { create } from 'zustand';
import { api, publicApi } from '@/utils/api';
import { Storage } from '@/utils/storage';

const APPEARANCE_CACHE_KEY = 'oxy_appearance_settings';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
}

export interface UserAppearance {
  oxyUserId: string;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  profileCustomization?: {
    coverPhotoEnabled?: boolean;
    minimalistMode?: boolean;
    displayName?: string;
    coverImage?: string;
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
      const cached = await Storage.get<UserAppearance>(APPEARANCE_CACHE_KEY);
      if (cached) {
        set({ mySettings: cached });
      }

      // Fetch fresh data from API
      const res = await api.get<UserAppearance>('profile/settings/me');
      const doc = res.data;
      
      // Cache the settings
      await Storage.set(APPEARANCE_CACHE_KEY, doc);
      
      set((state) => ({
        mySettings: doc,
        byUserId: { ...state.byUserId, [doc.oxyUserId]: doc },
        loading: false,
      }));
    } catch (e: any) {
      set({ loading: false, error: e?.message || 'Failed to load settings' });
    }
  },

  async loadForUser(userId: string, forceRefresh: boolean = false) {
    if (!userId) return null;
    
    try {
      const cached = get().byUserId[userId];
      if (cached && !forceRefresh) return cached;
      
      const res = await publicApi.get<UserAppearance>(`profile/design/${userId}`);
      const doc = res.data;
      
      set((state) => ({
        byUserId: { ...state.byUserId, [userId]: doc },
      }));
      
      return doc;
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
      };
      
      const res = await api.put<UserAppearance>('profile/settings', payload);
      const doc = res.data;
      
      // Update cache
      await Storage.set(APPEARANCE_CACHE_KEY, doc);
      
      set((state) => ({
        mySettings: doc,
        byUserId: { ...state.byUserId, [doc.oxyUserId]: doc },
        loading: false,
      }));
      
      return doc;
    } catch (e: any) {
      set({ loading: false, error: e?.message || 'Failed to update settings' });
      return null;
    }
  },
}));
