import { useEffect, useMemo } from 'react';
import { useTheme } from '@oxyhq/bloom/theme';
import { vars } from 'react-native-css';
import {
  APP_COLOR_PRESETS,
  getScopedColorCSSVariables,
  type AppColorName,
} from '@/lib/app-color-presets';
import { useScreenColor } from '@/context/ScreenColorContext';

interface ProfileScreenColorInput {
  /** Username from the URL. Used for forced brand themes. */
  username: string | undefined;
  /** Colour name stored on the profile's design. */
  designColor: string | undefined;
  /**
   * True when the visited profile belongs to the current user. Own profile uses
   * the user's chosen app-wide theme instead of any stored design colour.
   */
  isOwnProfile: boolean;
}

interface ProfileScreenColorResult {
  /** Resolved colour name (undefined = use default theme). */
  colorName: AppColorName | undefined;
  /** Preset lookup for the resolved colour (undefined when no override). */
  preset: (typeof APP_COLOR_PRESETS)[AppColorName] | undefined;
  /** Style object containing scoped CSS variables to apply to a container View. */
  colorVars: ReturnType<typeof vars> | undefined;
  /** Explicit background colour to force bg-background overrides inside the scoped tree. */
  backgroundColor: string | undefined;
}

/**
 * Usernames that always render with a specific brand colour, regardless of the
 * value stored on the profile design.
 */
const FORCED_BRAND_COLORS: Record<string, AppColorName> = {
  faircoin: 'faircoin',
};

function resolveForcedColor(username: string | undefined): AppColorName | undefined {
  if (!username) return undefined;
  return FORCED_BRAND_COLORS[username.toLowerCase()];
}

/**
 * Shared hook that resolves the colour preset for a visited profile screen
 * (/@username, /@username/about, /@username/connections, etc.) and propagates
 * it to the app layout so layout-owned elements (SignInBanner, middle column)
 * inherit the same theme. Each screen that renders inside the profile subtree
 * should call this hook so the colour stays consistent as the user switches
 * between profile tabs, and resets cleanly when the user navigates away.
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

  const preset = colorName ? APP_COLOR_PRESETS[colorName] : undefined;

  // Propagate to layout so elements rendered outside this screen (middle
  // column background, sign-in banner, etc.) share the same theme. Cleanup
  // resets the layout value on unmount so navigating away never leaks colour.
  useEffect(() => {
    setScreenColor(colorName);
    return () => setScreenColor(undefined);
  }, [colorName, setScreenColor]);

  const colorVars = useMemo(() => {
    if (!preset) return undefined;
    return vars(getScopedColorCSSVariables(preset, theme.isDark ? 'dark' : 'light'));
  }, [preset, theme.isDark]);

  const backgroundColor = useMemo(() => {
    if (!preset) return undefined;
    const hslValues = (theme.isDark ? preset.dark : preset.light)['--background'];
    return hslValues ? `hsl(${hslValues.replace(/ /g, ', ')})` : undefined;
  }, [preset, theme.isDark]);

  return { colorName, preset, colorVars, backgroundColor };
}
