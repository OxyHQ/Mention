import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { pokeService } from '@/services/pokeService';

export interface UsePokeReturn {
  poked: boolean;
  loading: boolean;
  toggle: () => Promise<void>;
}

const LAZY_FETCH_DELAY_MS = 500;

/**
 * Hook for managing poke state on a profile.
 * Defers the initial status fetch to avoid blocking profile render.
 */
export function usePoke(
  profileId: string | undefined,
  isOwnProfile: boolean
): UsePokeReturn {
  const { t } = useTranslation();
  const [poked, setPoked] = useState(false);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  // Defer poke status fetch — non-critical data that doesn't affect layout
  useEffect(() => {
    if (isOwnProfile || !profileId) return;

    fetchedRef.current = false;
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const { poked: isPoked } = await pokeService.getStatus(profileId);
        if (!cancelled) {
          setPoked(!!isPoked);
          fetchedRef.current = true;
        }
      } catch {
        // Silently ignore errors
      }
    }, LAZY_FETCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [profileId, isOwnProfile]);

  // Toggle poke — fetches status first if not yet loaded
  const toggle = useCallback(async () => {
    if (!profileId || loading || isOwnProfile) return;

    // If we haven't fetched yet, fetch now before toggling
    if (!fetchedRef.current) {
      try {
        const { poked: isPoked } = await pokeService.getStatus(profileId);
        setPoked(!!isPoked);
        fetchedRef.current = true;
      } catch {
        // Continue with default state
      }
    }

    setLoading(true);
    const previousState = poked;
    setPoked(!previousState);

    try {
      if (!previousState) {
        await pokeService.poke(profileId);
        toast.success(t('poke.sent', { defaultValue: 'Poked!' }));
      } else {
        await pokeService.unpoke(profileId);
        toast.success(t('poke.undone', { defaultValue: 'Poke undone' }));
      }
    } catch (error: any) {
      setPoked(previousState);
      const errorMessage = error?.response?.data?.message || error?.message || t('poke.error', { defaultValue: 'Failed to poke' });
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [profileId, loading, poked, isOwnProfile, t]);

  return {
    poked,
    loading,
    toggle,
  };
}
