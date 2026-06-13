import { useEffect } from 'react';
import { useAuth } from '@oxyhq/services';
import { useBloomTheme, hexToAppColorName, type ThemeMode } from '@oxyhq/bloom/theme';
import { useAppearanceStore } from '@/store/appearanceStore';

const VALID_THEME_MODES: ReadonlySet<ThemeMode> = new Set<ThemeMode>([
  'light',
  'dark',
  'system',
  'adaptive',
]);

function isValidThemeMode(value: string | undefined): value is ThemeMode {
  return typeof value === 'string' && VALID_THEME_MODES.has(value as ThemeMode);
}

export function useServerAppearanceSync(): void {
  const { isAuthenticated } = useAuth();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const { setMode, setColorPreset } = useBloomTheme();

  useEffect(() => {
    if (!isAuthenticated) return;
    void loadMySettings(true);
  }, [isAuthenticated, loadMySettings]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const appearance = mySettings?.appearance;
    if (!appearance) return;

    if (isValidThemeMode(appearance.themeMode)) {
      setMode(appearance.themeMode);
    }

    if (appearance.primaryColor && appearance.primaryColor.length > 0) {
      setColorPreset(hexToAppColorName(appearance.primaryColor));
    }
  }, [isAuthenticated, mySettings, setMode, setColorPreset]);
}
