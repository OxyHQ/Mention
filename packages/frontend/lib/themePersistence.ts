import AsyncStorage from '@react-native-async-storage/async-storage';
import { type BloomThemeBootstrapConfig, createBloomThemeStorage } from '@oxy.so/bloom/theme';
import { APP_DEFAULT_COLOR_PRESET } from '@/lib/colorEntitlement';

/**
 * Where Bloom persists the active theme (`{ mode?, colorPreset? }` as JSON).
 * `BloomProvider` writes it and `AppSplashScreen` reads it before the theme
 * context exists, so both take the key and storage from this one place.
 *
 * Web gets synchronous `localStorage` (no palette flash before first paint);
 * native gets `AsyncStorage`.
 */
export const { persistKey: BLOOM_THEME_PERSIST_KEY, storage: BLOOM_THEME_STORAGE } =
  createBloomThemeStorage('mention.bloom.theme', AsyncStorage);

/**
 * The theme the document paints before any JavaScript runs, and that the
 * provider adopts (`prepaintTheme`). `scripts/web-theme-prepaint.mjs` writes the
 * same configuration into the exported `index.html`; `themePersistence.test.ts`
 * holds the two equal.
 */
export const THEME_PREPAINT: BloomThemeBootstrapConfig = {
  defaultMode: 'system',
  defaultColorPreset: APP_DEFAULT_COLOR_PRESET,
  persistKey: BLOOM_THEME_PERSIST_KEY,
};
