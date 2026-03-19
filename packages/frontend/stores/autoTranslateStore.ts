import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface AutoTranslateStore {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useAutoTranslateStore = create<AutoTranslateStore>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: 'auto-translate-preference',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
