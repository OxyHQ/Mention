import { useEffect, useMemo } from 'react';
import { APP_COLOR_PRESETS, useTheme, type AppColorName } from '@oxyhq/bloom/theme';
import { useScreenColor } from '@/context/ScreenColorContext';

interface ProfileScreenColorInput {
  username: string | undefined;
  designColor: string | undefined;
  isOwnProfile: boolean;
}

interface ProfileScreenColorResult {
  /** Resolved color name, or `undefined` when the screen should inherit the app theme. */
  colorName: AppColorName | undefined;
  /** Resolved `hsl(...)` background color matching the resolved preset, or `undefined`. */
  backgroundColor: string | undefined;
}

const FORCED_BRAND_COLORS: Record<string, AppColorName> = {
  faircoin: 'faircoin',
};

function resolveForcedColor(username: string | undefined): AppColorName | undefined {
  if (!username) return undefined;
  return FORCED_BRAND_COLORS[username.toLowerCase()];
}

/**
 * Resolves the color preset for a visited profile screen and propagates it to
 * the layout (SignInBanner, middle column) via `ScreenColorContext`. The
 * screen wraps its content with `<ProfileColorScope colorName>` to apply the
 * preset to the subtree.
 */
export function useProfileScreenColor({
  username,
  designColor,
  isOwnProfile,
}: ProfileScreenColorInput): ProfileScreenColorResult {
  const theme = useTheme();
  const { setScreenColor } = useScreenColor();

  const colorName = useMemo<AppColorName | undefined>(() => {
    if (isOwnProfile) return undefined;
    const forced = resolveForcedColor(username);
    if (forced) return forced;
    if (!designColor) return undefined;
    return designColor in APP_COLOR_PRESETS ? (designColor as AppColorName) : undefined;
  }, [isOwnProfile, username, designColor]);

  useEffect(() => {
    setScreenColor(colorName);
    return () => setScreenColor(undefined);
  }, [colorName, setScreenColor]);

  const backgroundColor = useMemo(() => {
    if (!colorName) return undefined;
    const preset = APP_COLOR_PRESETS[colorName];
    const hsl = (theme.isDark ? preset.dark : preset.light)['--background'];
    return hsl ? `hsl(${hsl.replace(/ /g, ', ')})` : undefined;
  }, [colorName, theme.isDark]);

  return { colorName, backgroundColor };
}
