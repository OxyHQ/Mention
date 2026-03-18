import { useCallback, useState } from 'react';
import { useAuth } from '@oxyhq/services';
import { useThemeStore } from '@/lib/theme-store';
import { useAppearanceStore } from '@/store/appearanceStore';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxyhq/bloom/theme';

/**
 * Hook that centralizes the three-step color save sequence:
 * 1. Update local theme store for immediate effect
 * 2. Save color name to Oxy core (shared across ecosystem)
 * 3. Save hex to Mention backend (for backward compat / profile design)
 */
export function useAppColorSave() {
  const { oxyServices } = useAuth();
  const setAppColor = useThemeStore((s) => s.setAppColor);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const [saving, setSaving] = useState(false);

  const saveColor = useCallback(async (name: AppColorName) => {
    setSaving(true);
    setAppColor(name);
    const hex = APP_COLOR_PRESETS[name].hex;
    try {
      await Promise.all([
        oxyServices.updateProfile({ color: name }),
        updateMySettings({
          appearance: { primaryColor: hex },
        } as Record<string, unknown>),
      ]);
    } catch (error) {
      console.error('Error updating color:', error);
    } finally {
      setSaving(false);
    }
  }, [oxyServices, setAppColor, updateMySettings]);

  return { saveColor, saving };
}
