import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setColorSchemeSafe, applyDarkClass } from '@oxyhq/bloom/theme';
import { applyAppColorToDocument, type AppColorName } from './app-color-presets';

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
        const resolved: 'light' | 'dark' = effectiveMode === 'system'
          ? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : effectiveMode as 'light' | 'dark';
        applyDarkClass(resolved);
        // Apply CSS variables for the persisted preset before React mounts so
        // the very first paint already shows the correct palette. Once
        // BloomThemeProvider mounts it becomes the authoritative writer for the
        // same variables (writing identical raw HSL triples).
        if (state.appColor) {
          applyAppColorToDocument(state.appColor, resolved);
        }
      },
    }
  )
);
