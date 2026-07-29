import { useEffect, useMemo } from 'react';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxyhq/bloom/theme';
import { useScreenColor } from '@/context/ScreenColorContext';

interface ProfileScreenColorInput {
  username: string | undefined;
  designColor: string | undefined;
}

interface ProfileScreenColorResult {
  /** Resolved color name, or `undefined` when the screen should inherit the app theme. */
  colorName: AppColorName | undefined;
}

const FORCED_BRAND_COLORS: Record<string, AppColorName> = {
  faircoin: 'faircoin',
};

function resolveForcedColor(username: string | undefined): AppColorName | undefined {
  if (!username) return undefined;
  return FORCED_BRAND_COLORS[username.toLowerCase()];
}

/**
 * The color preset a profile is themed with: a forced brand color when the
 * handle has one, else the profile's own `design.color` when it names a real
 * preset, else `undefined` (inherit the app theme).
 *
 * Pure, and deliberately separate from {@link useProfileScreenColor}: the hook
 * also PUBLISHES the color to the surrounding screen (`ScreenColorContext`),
 * which is right for a profile screen and wrong for anything that merely shows
 * a profile in passing — a hover preview must not repaint the screen behind it.
 * Those callers scope the preset to their own subtree with `BloomColorScope`.
 */
export function resolveProfileColorName(
  username: string | undefined,
  designColor: string | undefined,
): AppColorName | undefined {
  const forced = resolveForcedColor(username);
  if (forced) return forced;
  if (!designColor) return undefined;
  return designColor in APP_COLOR_PRESETS ? (designColor as AppColorName) : undefined;
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
}: ProfileScreenColorInput): ProfileScreenColorResult {
  const { setScreenColor } = useScreenColor();

  const colorName = useMemo<AppColorName | undefined>(
    () => resolveProfileColorName(username, designColor),
    [username, designColor],
  );

  useEffect(() => {
    setScreenColor(colorName);
    return () => setScreenColor(undefined);
  }, [colorName, setScreenColor]);

  return { colorName };
}
