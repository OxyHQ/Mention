import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AppColorName } from '@oxyhq/bloom/theme';
import { setColorSchemeSafe } from '@oxyhq/bloom/theme';
import { applyDarkClass } from '@oxyhq/bloom/theme';
import { applyAppColorToDocument } from './app-color-presets';

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
        if (state.appColor && state.appColor !== 'teal') {
          applyAppColorToDocument(state.appColor, resolved);
        }
      },
    }
  )
);
