import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { type AppColorName, applyAppColorToDocument } from './app-color-presets';
import { setColorSchemeSafe } from './set-color-scheme-safe';

export type ThemeMode = 'light' | 'dark' | 'system' | 'adaptive';

interface ThemeState {
  mode: ThemeMode;
  appColor: AppColorName;
  setMode: (mode: ThemeMode) => void;
  setAppColor: (color: AppColorName) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      appColor: 'teal',
      setMode: (mode: ThemeMode) => set({ mode }),
      setAppColor: (appColor: AppColorName) => set({ appColor }),
    }),
    {
      name: 'mention-theme-storage',
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        if (!state?.mode) return;
        const effectiveMode = state.mode === 'adaptive' ? 'system' : state.mode;
        setColorSchemeSafe(effectiveMode);
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
          const resolved = effectiveMode === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : effectiveMode;
          document.documentElement.classList.toggle('dark', resolved === 'dark');
          if (state.appColor && state.appColor !== 'teal') {
            applyAppColorToDocument(state.appColor, resolved as 'light' | 'dark');
          }
        }
      },
    }
  )
);
