import { useEffect } from 'react';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useAuth } from '@oxyhq/services';

/**
 * Loads the viewer's Mention appearance settings (post-text length, read-more
 * behavior, bio collapse, profile customization) into the appearance store once
 * the session can reach the private API.
 *
 * The active Bloom theme (color mode + preset) is NOT driven from here: it is
 * owned by `useAccountThemeSync`, which applies the portable Oxy account theme
 * (`user.themePreference`) when the local source is `account`, and otherwise
 * leaves Bloom on its own persisted (app-default) value.
 */
export function useServerAppearanceSync(): void {
  const { canUsePrivateApi } = useAuth();
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);

  useEffect(() => {
    if (!canUsePrivateApi) return;
    void loadMySettings(true);
  }, [canUsePrivateApi, loadMySettings]);
}
