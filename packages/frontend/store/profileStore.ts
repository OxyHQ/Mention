import { create } from 'zustand';
import api from '@/utils/api';

interface Profile {
  id: string;
  oxyUserId: string;
  username: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  coverImage?: string;
  location?: string;
  website?: string;
  followers?: number;
  following?: number;
  postsCount?: number;
  verified?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProfileStore {
  profile: Profile | null;
  profileLoading: boolean;
  profileError: string | null;
  fetchProfile: (oxyUserId: string) => Promise<void>;
  clearProfile: () => void;
  setProfile: (profile: Profile) => void;
  refreshProfile: (oxyUserId: string) => Promise<void>;
}

export const useProfileStore = create<ProfileStore>((set) => ({
  profile: null,
  profileLoading: false,
  profileError: null,
  fetchProfile: async (oxyUserId: string) => {
    set({ profileLoading: true, profileError: null });
    try {
      const response = await api.get(`profiles/${oxyUserId}`);
      set({ profile: response.data, profileLoading: false });
    } catch (error: any) {
      set({ profileError: error?.message || 'Failed to fetch profile', profileLoading: false });
    }
  },
  clearProfile: () => set({ profile: null, profileError: null }),
  setProfile: (profile: Profile) => set({ profile }),
  refreshProfile: async (oxyUserId: string) => {
    set({ profileLoading: true, profileError: null });
    try {
      const response = await api.get(`profiles/${oxyUserId}`);
      set({ profile: response.data, profileLoading: false });
    } catch (error: any) {
      set({ profileError: error?.message || 'Failed to refresh profile', profileLoading: false });
    }
  },
})); 