import { create } from 'zustand';
import { Platform } from 'react-native';
import { logger } from '@oxy.so/core/logger';
import { Storage } from '../utils/storage';

const VIDEO_MUTE_STORAGE_KEY = 'pref:global:videoMuted';

// Platform-specific defaults:
// - Web: muted (true) due to browser autoplay restrictions
// - Native: unmuted (false) for better user experience
const getDefaultMutedState = (): boolean => {
  return Platform.OS === 'web';
};

/**
 * Whether the viewer has interacted with this document — the browser's "sticky
 * activation", the thing its autoplay policy asks about.
 *
 * Browsers refuse to START media with sound before the first user gesture on a
 * page: `play()` rejects with `NotAllowedError` (seen on a profile with video,
 * opened fresh, by a viewer who had unmuted on an earlier visit). Muted
 * playback is always allowed, so on web the store never lets a video be
 * unmuted until this is true: the saved preference is not restored on a fresh
 * page, and an unmute asked for without a gesture behind it is refused. The
 * mute button is itself a gesture, so pressing it always works.
 *
 * `navigator.userActivation.hasBeenActive` where the browser has it; elsewhere
 * (older Safari) the first pointer, touch or key event this module sees, which
 * are the events that grant activation.
 */
let sawUserGesture = false;
const USER_ACTIVATION_EVENTS = ['pointerdown', 'touchend', 'keydown', 'click'] as const;

function noteUserGesture(): void {
  sawUserGesture = true;
  for (const type of USER_ACTIVATION_EVENTS)
    window.removeEventListener(type, noteUserGesture, true);
}

if (
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  for (const type of USER_ACTIVATION_EVENTS) window.addEventListener(type, noteUserGesture, true);
}

export function webMayPlayWithSound(): boolean {
  if (Platform.OS !== 'web') return true;
  const activation = (
    globalThis.navigator as
      | (Navigator & { userActivation?: { hasBeenActive?: boolean } })
      | undefined
  )?.userActivation;
  return activation?.hasBeenActive === true || sawUserGesture;
}

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
    // Unmuting without a gesture behind it would make the next autoplay a
    // refused one (see `webMayPlayWithSound`): stay muted, and keep the saved
    // preference as it was.
    if (!muted && !webMayPlayWithSound()) {
      set({ isMuted: true });
      return;
    }
    set({ isMuted: muted });
    await Storage.set(VIDEO_MUTE_STORAGE_KEY, muted);
  },

  toggleMuted: async () => {
    await get().setMuted(!get().isMuted);
  },

  loadMutedState: async () => {
    set({ isLoading: true });
    try {
      const savedMuted = await Storage.get<boolean>(VIDEO_MUTE_STORAGE_KEY);
      // If no saved value, use platform-specific default
      const preferred = savedMuted !== null ? savedMuted : getDefaultMutedState();
      // A fresh web page has had no gesture yet, so it always starts muted; the
      // viewer's unmute brings the sound back (see `webMayPlayWithSound`).
      set({ isMuted: preferred || !webMayPlayWithSound(), isLoading: false });
    } catch (error) {
      logger.error('Failed to load muted state', error);
      set({ isMuted: getDefaultMutedState(), isLoading: false });
    }
  },
}));
