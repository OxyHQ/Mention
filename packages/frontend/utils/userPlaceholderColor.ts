import { APP_COLOR_PRESETS } from '@oxyhq/bloom/theme';

/**
 * Returns the hex color for a user's profile color, to be used as
 * the Avatar placeholder background when no avatar image is available.
 */
export function getUserPlaceholderColor(user?: { color?: string | null } | null): string | undefined {
    const color = user?.color;
    if (!color) return undefined;
    // Matching the stored string against the preset names is what narrows it to a
    // real preset, so an unknown or stale color simply yields no placeholder.
    return Object.entries(APP_COLOR_PRESETS).find(([name]) => name === color)?.[1].hex;
}
