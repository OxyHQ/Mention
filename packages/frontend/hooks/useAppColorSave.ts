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
  const { oxyServices, user } = useAuth();
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
      // read. Without this, the viewer's own profile keeps rendering the
      // pre-change accent color (via `useProfileScreenColor` → `BloomColorScope`)
      // until the 5-minute staleTime elapses or a full reload. Scope the
      // invalidation to the VIEWER'S OWN entries only: invalidating the whole
      // `queryKeys.users.details()` subtree would drop every cached profile and
      // user-card app-wide for a change to the viewer's own color. `detail(ownId)`
      // prefix-matches the by-id entry AND any `detailForViewer(ownId, …)` entry;
      // the by-username entry is a separate key and needs its own call. The
      // viewer's own profile is always local, so no federated-resolve key applies.
      // `updateMySettings` already invalidates the `['appearance', ...]` key.
      const ownId = user?.id;
      const ownUsername = user?.username;
      if (ownId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.users.detail(ownId) });
      }
      if (ownId && ownUsername) {
        queryClient.invalidateQueries({ queryKey: queryKeys.users.byUsername(ownUsername, ownId) });
      }
    } catch (error) {
      logger.error('Error updating color', { error });
    } finally {
      setSaving(false);
    }
  }, [oxyServices, setColorPreset, updateMySettings, source, mode, user]);

  return { saveColor, saving };
}
