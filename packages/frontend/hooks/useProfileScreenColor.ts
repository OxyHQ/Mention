import { useMemo } from 'react';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxy.so/bloom/theme';

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

/** Resolve a profile recipe; Bloom Screen applies it to its own host. */
export function resolveProfileColorName(
  username: string | undefined,
  designColor: string | undefined,
): AppColorName | undefined {
  const forced = resolveForcedColor(username);
  if (forced) return forced;
  if (!designColor) return undefined;
  return designColor in APP_COLOR_PRESETS ? (designColor as AppColorName) : undefined;
}

/** Resolve the recipe without mutating a surrounding screen or global theme. */
export function useProfileScreenColor({
  username,
  designColor,
}: ProfileScreenColorInput): ProfileScreenColorResult {
  const colorName = useMemo<AppColorName | undefined>(
    () => resolveProfileColorName(username, designColor),
    [username, designColor],
  );

  return { colorName };
}
