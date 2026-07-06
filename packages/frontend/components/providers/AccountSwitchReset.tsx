import { useEffect, useRef } from 'react';
import { useAuth } from '@oxyhq/services';
import { useBloomTheme } from '@oxyhq/bloom/theme';
import { useAppearanceStore } from '@/store/appearanceStore';

/**
 * Clears the previous account's scoped UI state (appearance + Bloom theme)
 * when the active account SWITCHES.
 *
 * Replaces the SDK's removed per-button `onBeforeSessionChange` hook — and
 * covers more: it fires for every switch path (sidebar ProfileButton, the
 * unified account dialog, remote-driven switches over the device socket),
 * not just one button. The prev-id ref distinguishes a genuine switch
 * (`prev && next && prev !== next`) from the cold-boot restore (`null → user`)
 * and sign-out (`user → null`), so the user's persisted appearance survives
 * app starts.
 */
export function AccountSwitchReset() {
  const { user } = useAuth();
  const { resetTheme } = useBloomTheme();
  const resetAppearance = useAppearanceStore((state) => state.reset);
  const prevUserIdRef = useRef<string | null>(null);

  const userId = user?.id ?? null;
  useEffect(() => {
    const prev = prevUserIdRef.current;
    prevUserIdRef.current = userId;
    if (prev && userId && prev !== userId) {
      resetAppearance();
      resetTheme();
    }
  }, [userId, resetAppearance, resetTheme]);

  return null;
}
