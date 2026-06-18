import { useEffect } from 'react';
import { useBloomTheme, hexToAppColorName, type ThemeMode } from '@oxyhq/bloom/theme';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useAuth } from '@oxyhq/services';

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
  const { canUsePrivateApi } = useAuth();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const { setMode, setColorPreset } = useBloomTheme();

  useEffect(() => {
    if (!canUsePrivateApi) return;
    void loadMySettings(true);
  }, [canUsePrivateApi, loadMySettings]);

  useEffect(() => {
    if (!canUsePrivateApi) return;
    const appearance = mySettings?.appearance;
    if (!appearance) return;

    if (isValidThemeMode(appearance.themeMode)) {
      setMode(appearance.themeMode);
    }

    if (appearance.primaryColor && appearance.primaryColor.length > 0) {
      setColorPreset(hexToAppColorName(appearance.primaryColor));
    }
  }, [canUsePrivateApi, mySettings, setMode, setColorPreset]);
}
