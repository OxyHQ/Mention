import { create } from 'zustand';
import { api } from '@/utils/api';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
}

export interface UserAppearance {
  oxyUserId: string;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface AppearanceStore {
  mySettings: UserAppearance | null;
  byUserId: Record<string, UserAppearance>;
  loading: boolean;
  error: string | null;
  loadMySettings: () => Promise<void>;
  loadForUser: (userId: string) => Promise<UserAppearance | null>;
  updateMySettings: (partial: Partial<UserAppearance>) => Promise<UserAppearance | null>;
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => ({
  mySettings: null,
  byUserId: {},
  loading: false,
  error: null,
  async loadMySettings() {
    try {
      set({ loading: true, error: null });
      const res = await api.get<UserAppearance>('profile/settings/me');
      const doc = res.data;
      set((state) => ({
        mySettings: doc,
        byUserId: { ...state.byUserId, [doc.oxyUserId]: doc },
        loading: false,
      }));
    } catch (e: any) {
      set({ loading: false, error: e?.message || 'Failed to load settings' });
    }
  },
  async loadForUser(userId: string) {
    try {
      const cached = get().byUserId[userId];
      if (cached) return cached;
      const res = await api.get<UserAppearance>(`profile/settings/${userId}`);
      const doc = res.data;
      set((state) => ({ byUserId: { ...state.byUserId, [userId]: doc } }));
      return doc;
    } catch (e) {
      return null;
    }
  },
  async updateMySettings(partial: Partial<UserAppearance>) {
    try {
      set({ loading: true, error: null });
      // Only send allowed fields
      const payload: any = {};
      if (partial.appearance) payload.appearance = partial.appearance;
      if (Object.prototype.hasOwnProperty.call(partial, 'profileHeaderImage')) {
        payload.profileHeaderImage = partial.profileHeaderImage;
      }
      const res = await api.put<UserAppearance>('profile/settings', payload);
      const doc = res.data;
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
