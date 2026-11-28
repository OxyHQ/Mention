import AsyncStorage from '@react-native-async-storage/async-storage';
import { createBloomThemeStorage } from '@oxy.so/bloom/theme';

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
