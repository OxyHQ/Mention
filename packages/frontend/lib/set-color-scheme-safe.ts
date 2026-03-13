import { Appearance, Platform } from 'react-native';
import type { ColorSchemeName } from 'react-native';
import type { ThemeMode } from './theme-store';

/**
 * Safely set the color scheme via Appearance API.
 * On Android (RN 0.83+), Appearance.setColorScheme has a Kotlin non-null
 * annotation on `style`. Passing null for 'system' crashes.
 * Workaround: resolve the system preference and pass 'light'/'dark' instead.
 */
export function setColorSchemeSafe(mode: ThemeMode) {
  const effectiveMode = mode === 'adaptive' ? 'system' : mode;
  if (effectiveMode === 'system') {
    if (Platform.OS === 'android') {
      const resolved: ColorSchemeName = Appearance.getColorScheme() ?? 'light';
      Appearance.setColorScheme(resolved);
    } else {
      Appearance.setColorScheme(null);
    }
  } else {
    Appearance.setColorScheme(effectiveMode);
  }
}
