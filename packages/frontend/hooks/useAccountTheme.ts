import { useEffect, useRef } from 'react';
import { useAccountTheme, useAuth } from '@oxy.so/services/ui/client';
import { useBloomTheme, APP_COLOR_PRESETS, type AppColorName } from '@oxy.so/bloom/theme';
import { useMentionColorViewer } from '@/hooks/useMentionColorViewer';
import { APP_DEFAULT_COLOR_PRESET, isColorEntitled } from '@/lib/colorEntitlement';

/**
 * Bumped by every explicit preset choice, so a preset withheld while authority
 * was unknown is never restored over a newer selection.
 */
let presetSelectionEpoch = 0;

/** Call on every explicit colour choice (see `useAppColorSave`). */
export function markPresetSelection(): void {
  presetSelectionEpoch += 1;
}

function isAppColorName(value: string): value is AppColorName {
  return Object.hasOwn(APP_COLOR_PRESETS, value);
}

/**
 * Mention's theme bridge. The Oxy account theme (colour always, mode while this
 * device follows the account) is the SDK's `useAccountTheme`; Mention adds only
 * its paywall: `canUse` withholds a preset this viewer is not entitled to, and
 * a preset already applied is revoked below.
 *
 * Mount ONCE, near the auth root.
 */
export function useAccountThemeSync(): void {
  const { user } = useAuth();
  const { colorPreset, setColorPreset } = useBloomTheme();
  const viewer = useMentionColorViewer();
  useAccountTheme({ canUse: (name) => isColorEntitled(name, viewer) });

  // REVOKE a preset the viewer is no longer entitled to.
  //
  // Gating the picker only stops someone CHOOSING a colour; it does nothing about
  // one already chosen. A subscriber who picked the colourless theme and then
  // lapsed kept rendering it indefinitely, because both the account preference
  // and Bloom's own local persistence store a preset NAME and validate only that
  // the name exists. So the paywall held on one screen and nowhere else.
  //
  // This runs whatever the theme source: a stale entitlement can arrive by
  // either route — Bloom's local storage paints on cold boot before any account
  // theme lands, and under the `app` source it is the only thing that ever paints.
  //
  // Missing authority, sign-out and account switches fall back to a free preset.
  // While the permission read is still pending that fallback is temporary: the
  // account's own choice is withheld, not discarded, and comes back once the
  // read confirms it — for the same account, and only if nothing newer was
  // chosen meanwhile. Without this a paying viewer lost a saved preset on every
  // cold start: only the account colour, never a preset kept on this device, is
  // re-applied once authority arrives.
  const withheld = useRef<{ userId: string; preset: AppColorName; epoch: number } | null>(null);
  useEffect(() => {
    if (!isColorEntitled(colorPreset, viewer)) {
      withheld.current =
        user?.id && isAppColorName(colorPreset)
          ? { userId: user.id, preset: colorPreset, epoch: presetSelectionEpoch }
          : null;
      setColorPreset(APP_DEFAULT_COLOR_PRESET);
      return;
    }
    const held = withheld.current;
    if (!held) return;
    if (
      held.userId !== user?.id ||
      held.epoch !== presetSelectionEpoch ||
      colorPreset !== APP_DEFAULT_COLOR_PRESET
    ) {
      withheld.current = null;
      return;
    }
    if (isColorEntitled(held.preset, viewer)) {
      withheld.current = null;
      setColorPreset(held.preset);
    }
  }, [user, colorPreset, setColorPreset, viewer]);
}
