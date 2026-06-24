import { useCallback, useState } from 'react';
import { useAuth, queryKeys } from '@oxyhq/services';
import { APP_COLOR_PRESETS, useBloomTheme, type AppColorName } from '@oxyhq/bloom/theme';
import { logger } from '@/lib/logger';
import { queryClient } from '@/lib/queryClient';
import { useAppearanceStore } from '@/store/appearanceStore';

/**
 * Hook that centralizes the three-step color save sequence:
 * 1. Update Bloom theme for immediate effect
 * 2. Save color name to Oxy core (shared across ecosystem)
 * 3. Save hex to Mention backend (for backward compat / profile design)
 */
export function useAppColorSave() {
  const { oxyServices } = useAuth();
  const { setColorPreset } = useBloomTheme();
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const [saving, setSaving] = useState(false);

  const saveColor = useCallback(async (name: AppColorName) => {
    setSaving(true);
    setColorPreset(name);
    const hex = APP_COLOR_PRESETS[name].hex;
    try {
      await Promise.all([
        oxyServices.updateProfile({ color: name }),
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
  }, [oxyServices, setColorPreset, updateMySettings]);

  return { saveColor, saving };
}
