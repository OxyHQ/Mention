import { useCallback, useState } from 'react';
import { queryKeys } from '@oxy.so/services/ui/client';
import { useAuth } from '@oxy.so/services/ui/client';
import { useBloomTheme, type AppColorName } from '@oxy.so/bloom/theme';
import { logger } from '@oxy.so/core/logger';
import { isColorEntitled } from '@/lib/colorEntitlement';
import { markPresetSelection } from '@/hooks/useAccountTheme';
import { useMentionColorViewer } from '@/hooks/useMentionColorViewer';
import { queryClient } from '@/lib/queryClient';

/**
 * The profile colour IS the Oxy account colour, so there is exactly one write:
 * `color` and the portable `themePreference.colorPreset` go to Oxy in the SAME
 * `updateMe`, and every Oxy app reads them back from there. Oxy's API is the
 * authority on who may wear which preset (`oxy`/`faircoin` by handle, `mono` by
 * benefit); the entitlement check here only keeps the picker honest and the
 * request out of the way of a 400.
 *
 * The theme MODE stays what the account already has: choosing a colour must not
 * overwrite a light/dark choice made elsewhere.
 */
export function useAppColorSave() {
  const { oxyServices, user } = useAuth();
  const { mode, setColorPreset } = useBloomTheme();
  const viewer = useMentionColorViewer();
  const [saving, setSaving] = useState(false);

  const saveColor = useCallback(
    async (name: AppColorName) => {
      if (!isColorEntitled(name, viewer))
        throw new Error('Color is not available for this account');
      markPresetSelection();
      setSaving(true);
      setColorPreset(name);
      try {
        await oxyServices.users.updateMe({
          color: name,
          themePreference: {
            mode:
              user?.themePreference?.mode ??
              (mode === 'light' || mode === 'dark' ? mode : 'system'),
            colorPreset: name,
          },
        });
        // `updateMe` busts the SDK's HTTP response cache but NOT the React Query
        // user caches `useProfileData`/`useUserByUsername` read, so the viewer's
        // own profile would keep its old accent until the staleTime elapsed.
        // Scope it to the VIEWER'S OWN entries: invalidating the whole
        // `queryKeys.users.details()` subtree would drop every cached profile
        // app-wide. `detail(ownId)` prefix-matches the by-id entry and any
        // `detailForViewer(ownId, …)`; the by-username entry is a separate key.
        const ownId = user?.id;
        const ownUsername = user?.username;
        if (ownId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.users.detail(ownId) });
        }
        if (ownId && ownUsername) {
          queryClient.invalidateQueries({
            queryKey: queryKeys.users.byUsername(ownUsername, ownId),
          });
        }
      } catch (error) {
        logger.error('Error updating color', error);
      } finally {
        setSaving(false);
      }
    },
    [oxyServices, setColorPreset, mode, user, viewer],
  );

  return { saveColor, saving };
}
