import { useCallback, useState } from 'react';
import { useAuth, queryKeys } from '@oxyhq/services';
import { APP_COLOR_PRESETS, useBloomTheme, type AppColorName } from '@oxyhq/bloom/theme';
import { logger } from '@/lib/logger';
import { queryClient } from '@/lib/queryClient';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useThemeSourceStore } from '@/store/themeSourceStore';

/**
 * Hook that centralizes the color save sequence:
 * 1. Update Bloom theme for immediate effect.
 * 2. Save the color name to the Oxy user as the profile accent (`color`), plus —
 *    when the theme source is `account` — the portable account theme
 *    (`themePreference.colorPreset`) in the SAME profile write, so the preset
 *    rides other Oxy apps and survives the next cold boot (otherwise the theme
 *    bridge would reapply the previous account color).
 * 3. Save the hex to the Mention backend (for backward compat / profile design).
 */
export function useAppColorSave() {
  const { oxyServices } = useAuth();
  const { mode, setColorPreset } = useBloomTheme();
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const source = useThemeSourceStore((state) => state.source);
  const [saving, setSaving] = useState(false);

  const saveColor = useCallback(async (name: AppColorName) => {
    setSaving(true);
    setColorPreset(name);
    const hex = APP_COLOR_PRESETS[name].hex;
    const profileUpdate: Parameters<typeof oxyServices.updateProfile>[0] = { color: name };
    if (source === 'account') {
      profileUpdate.themePreference = {
        mode: mode === 'light' || mode === 'dark' ? mode : 'system',
        colorPreset: name,
      };
    }
    try {
      await Promise.all([
        oxyServices.updateProfile(profileUpdate),
        updateMySettings({
          appearance: { primaryColor: hex },
        }),
      ]);
      // `oxyServices.updateProfile` busts the SDK's internal HTTP response cache
      // but NOT the React Query user caches that `useProfileData`/`useUserByUsername`
      // read (`queryKeys.users.details()` covers the by-id, by-username, and
      // federated-resolve keys). Without this, the viewer's own profile keeps
      // rendering the pre-change accent color (via `useProfileScreenColor` →
      // `BloomColorScope`) until the 5-minute staleTime elapses or a full reload.
      // `updateMySettings` already invalidates the `['appearance', ...]` key.
      queryClient.invalidateQueries({ queryKey: queryKeys.users.details() });
    } catch (error) {
      logger.error('Error updating color', { error });
    } finally {
      setSaving(false);
    }
  }, [oxyServices, setColorPreset, updateMySettings, source, mode]);

  return { saveColor, saving };
}
