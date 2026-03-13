import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface HapticsStore {
  disabled: boolean;
  setDisabled: (disabled: boolean) => void;
  toggle: () => void;
}

export const useHapticsStore = create<HapticsStore>()(
  persist(
    (set) => ({
      disabled: false,
      setDisabled: (disabled) => set({ disabled }),
      toggle: () => set((state) => ({ disabled: !state.disabled })),
    }),
    {
      name: 'haptics-preference',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
