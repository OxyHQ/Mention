import { create } from 'zustand';
import { Platform } from 'react-native';
import { webLocalStorage } from '@oxyhq/bloom/theme';
import { BLOOM_THEME_STORAGE } from '@/lib/themePersistence';

/**
 * Where the active Bloom theme comes from, chosen per-app and per-device:
 * - `account`: the viewer's portable Oxy account theme (`user.themePreference`),
 *   shared across every Oxy app. This is the default — Mention participates.
 * - `app`: a theme kept only on THIS device/app, never written to the account.
 *
 * This toggle is a local, device-scoped preference. It is NEVER sent to a server
 * and never rides the account, so flipping it is instant and offline-safe.
 */
export type ThemeSource = 'app' | 'account';

const THEME_SOURCE_KEY = 'mention.theme.source';

function normalizeSource(raw: string | null): ThemeSource {
  // Default to `account` so Mention picks up the portable theme unless the user
  // has explicitly opted this device out.
  return raw === 'app' ? 'app' : 'account';
}

/**
 * Web reads `localStorage` synchronously, so the source is known before the
 * first paint and the theme bridge never applies the wrong source. Native's
 * `AsyncStorage` resolves via `hydrate()` shortly after mount.
 */
function readInitialSource(): { source: ThemeSource; hydrated: boolean } {
  if (Platform.OS === 'web' && webLocalStorage) {
    const raw = webLocalStorage.getItem(THEME_SOURCE_KEY);
    if (typeof raw === 'string' || raw === null) {
      return { source: normalizeSource(raw), hydrated: true };
    }
  }
  return { source: 'account', hydrated: false };
}

interface ThemeSourceStore {
  source: ThemeSource;
  /** True once the persisted source has been read (always true on web). */
  hydrated: boolean;
  setSource: (source: ThemeSource) => void;
  hydrate: () => Promise<void>;
}

export const useThemeSourceStore = create<ThemeSourceStore>((set, get) => ({
  ...readInitialSource(),

  setSource(source: ThemeSource) {
    set({ source });
    void Promise.resolve(BLOOM_THEME_STORAGE.setItem(THEME_SOURCE_KEY, source));
  },

  async hydrate() {
    if (get().hydrated) return;
    const raw = await Promise.resolve(BLOOM_THEME_STORAGE.getItem(THEME_SOURCE_KEY));
    set({ source: normalizeSource(raw), hydrated: true });
  },
}));
