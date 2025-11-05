import { create } from 'zustand';
import { Platform } from 'react-native';
import { storeData, getData } from '../utils/storage';

const VIDEO_MUTE_STORAGE_KEY = 'pref:global:videoMuted';

// Platform-specific defaults:
// - Web: muted (true) due to browser autoplay restrictions
// - Native: unmuted (false) for better user experience
const getDefaultMutedState = (): boolean => {
  return Platform.OS === 'web';
};

interface VideoMuteStore {
  isMuted: boolean;
  isLoading: boolean;
  setMuted: (muted: boolean) => Promise<void>;
  toggleMuted: () => Promise<void>;
  loadMutedState: () => Promise<void>;
}

export const useVideoMuteStore = create<VideoMuteStore>((set, get) => ({
  isMuted: getDefaultMutedState(), // Platform-specific default
  isLoading: true,

  setMuted: async (muted: boolean) => {
    set({ isMuted: muted });
    await storeData(VIDEO_MUTE_STORAGE_KEY, muted);
  },

  toggleMuted: async () => {
    const newMutedState = !get().isMuted;
    set({ isMuted: newMutedState });
    await storeData(VIDEO_MUTE_STORAGE_KEY, newMutedState);
  },

  loadMutedState: async () => {
    set({ isLoading: true });
    try {
      const savedMuted = await getData<boolean>(VIDEO_MUTE_STORAGE_KEY);
      // If no saved value, use platform-specific default
      const muted = savedMuted !== null ? savedMuted : getDefaultMutedState();
      set({ isMuted: muted, isLoading: false });
    } catch (error) {
      console.error('Failed to load muted state:', error);
      set({ isMuted: getDefaultMutedState(), isLoading: false });
    }
  },
}));

