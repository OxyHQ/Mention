import { APP_COLOR_PRESETS, type AppColorName } from '@/lib/app-color-presets';

/**
 * Returns the hex color for a user's profile color, to be used as
 * the Avatar placeholder background when no avatar image is available.
 */
export function getUserPlaceholderColor(user?: Record<string, any> | null): string | undefined {
    const colorName = user?.color as AppColorName | undefined;
    if (colorName && APP_COLOR_PRESETS[colorName]) {
        return APP_COLOR_PRESETS[colorName].hex;
    }
    return undefined;
}
