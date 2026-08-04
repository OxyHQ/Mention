import { useCallback, useEffect } from 'react';
import { useAuth } from '@oxyhq/services/ui/client';
import type { User } from '@oxyhq/core';
import {
  useBloomTheme,
  APP_COLOR_PRESETS,
  type AppColorName,
  type ThemeMode,
} from '@oxyhq/bloom/theme';
import { useThemeSourceStore, type ThemeSource } from '@/stores/themeSourceStore';
import { APP_DEFAULT_COLOR_PRESET, isColorEntitled } from '@/lib/colorEntitlement';

/**
 * The portable account theme value that rides the Oxy user DTO
 * (`user.themePreference`). Derived from the SDK `User` so the type always
 * tracks the published contract without importing `@oxyhq/contracts` directly.
 */
type AccountTheme = NonNullable<User['themePreference']>;
type PortableThemeMode = AccountTheme['mode'];

function isAppColorName(value: string): value is AppColorName {
  return Object.prototype.hasOwnProperty.call(APP_COLOR_PRESETS, value);
}

/**
 * Collapse Bloom's richer mode set onto the portable subset the account theme
 * stores (`adaptive` has no cross-app meaning, so it maps to `system`).
 */
function toPortableMode(mode: ThemeMode): PortableThemeMode {
  return mode === 'light' || mode === 'dark' ? mode : 'system';
}

/**
 * App-side theme bridge (all Oxy-specific logic lives HERE, never in Bloom).
 *
 * Applies the viewer's portable account theme (`user.themePreference`, which
 * rides the cold-boot session payload — zero extra fetch) into Bloom's imperative
 * setter whenever the local source is `account`. Bloom's own local persistence
 * still paints instantly on cold boot, so the account theme lands without a flash
 * once the session resolves (~5–25s on web).
 *
 * Mount ONCE, near the auth root. Reacts to session-land (the user object gains a
 * `themePreference`) and to source-toggle changes via its effect deps.
 */
export function useAccountThemeSync(): void {
  const { isAuthenticated, user } = useAuth();
  const source = useThemeSourceStore((state) => state.source);
  const hydrated = useThemeSourceStore((state) => state.hydrated);
  const hydrate = useThemeSourceStore((state) => state.hydrate);
  const { colorPreset, setMode, setColorPreset } = useBloomTheme();

  // Resolve the persisted source once (async on native; already resolved on web).
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const themePreference = user?.themePreference;

  useEffect(() => {
    // Resolution priority: participate by default → account theme when the source
    // is `account` and the user actually has one. `app` source or an absent
    // account theme leaves Bloom on its local (app-default) value.
    if (!hydrated || !isAuthenticated || source !== 'account' || !themePreference) {
      return;
    }
    setMode(themePreference.mode);
    if (isAppColorName(themePreference.colorPreset)) {
      setColorPreset(themePreference.colorPreset);
    }
  }, [hydrated, isAuthenticated, source, themePreference, setMode, setColorPreset]);

  // REVOKE a preset the viewer is no longer entitled to.
  //
  // Gating the picker only stops someone CHOOSING a colour; it does nothing about
  // one already chosen. A subscriber who picked the colourless theme and then
  // lapsed kept rendering it indefinitely, because both the account preference
  // and Bloom's own local persistence store a preset NAME and validate only that
  // the name exists. So the paywall held on one screen and nowhere else.
  //
  // Deliberately NOT inside the effect above: that one is scoped to the `account`
  // theme source, while a stale entitlement can arrive by either route — Bloom's
  // local storage paints on cold boot before any account theme lands, and under
  // the `app` source it is the only thing that ever paints.
  //
  // Guarded on the resolved user object rather than on `isAuthenticated` alone,
  // because entitlement is READ FROM IT: acting while it is still undefined would
  // read `isPremium` as false and strip a paying subscriber's theme on every cold
  // boot, in the window before the session resolves.
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const viewer = {
      username: user.username,
      isPremium: (user as { premium?: { isPremium?: boolean } }).premium?.isPremium ?? false,
    };
    if (!isColorEntitled(colorPreset, viewer)) {
      setColorPreset(APP_DEFAULT_COLOR_PRESET);
    }
  }, [isAuthenticated, user, colorPreset, setColorPreset]);
}

interface ThemeControls {
  source: ThemeSource;
  /** Switch the local theme source; seeds the account theme when first enabled. */
  changeThemeSource: (source: ThemeSource) => void;
  /** Change the color mode; writes back to the account when source is `account`. */
  changeThemeMode: (mode: ThemeMode) => Promise<void>;
  /** Change the color preset; writes back to the account when source is `account`. */
  changeColorPreset: (preset: AppColorName) => Promise<void>;
}

/**
 * Source-aware theme mutations for settings surfaces. Every change updates Bloom
 * immediately (local, no flash) and, when the source is `account`, persists the
 * full `{ mode, colorPreset }` to the Oxy account via `updateThemePreference` so
 * other Oxy apps pick it up on their next session load.
 */
export function useThemeControls(): ThemeControls {
  const { oxyServices, user } = useAuth();
  const { mode, colorPreset, setMode, setColorPreset } = useBloomTheme();
  const source = useThemeSourceStore((state) => state.source);
  const setSource = useThemeSourceStore((state) => state.setSource);

  const persistAccountTheme = useCallback(
    (next: { mode: ThemeMode; colorPreset: AppColorName }) =>
      oxyServices.updateThemePreference({
        mode: toPortableMode(next.mode),
        colorPreset: next.colorPreset,
      }),
    [oxyServices],
  );

  const changeThemeMode = useCallback(
    async (nextMode: ThemeMode) => {
      setMode(nextMode);
      if (source === 'account') {
        await persistAccountTheme({ mode: nextMode, colorPreset });
      }
    },
    [setMode, source, persistAccountTheme, colorPreset],
  );

  const changeColorPreset = useCallback(
    async (nextPreset: AppColorName) => {
      setColorPreset(nextPreset);
      if (source === 'account') {
        await persistAccountTheme({ mode, colorPreset: nextPreset });
      }
    },
    [setColorPreset, source, persistAccountTheme, mode],
  );

  const changeThemeSource = useCallback(
    (nextSource: ThemeSource) => {
      setSource(nextSource);
      if (nextSource !== 'account') return;
      // An existing account theme is applied by `useAccountThemeSync` (its effect
      // re-runs on the source change). Only when none exists yet do we seed it
      // from the current app theme so enabling sync captures what the user sees.
      const pref = user?.themePreference;
      if (!pref || !isAppColorName(pref.colorPreset)) {
        void persistAccountTheme({ mode, colorPreset });
      }
    },
    [setSource, user?.themePreference, persistAccountTheme, mode, colorPreset],
  );

  return { source, changeThemeSource, changeThemeMode, changeColorPreset };
}
