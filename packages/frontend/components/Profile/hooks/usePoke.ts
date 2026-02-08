import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { pokeService } from '@/services/pokeService';

export interface UsePokeReturn {
  poked: boolean;
  loading: boolean;
  toggle: () => Promise<void>;
}

/**
 * Hook for managing poke state on a profile
 * Handles loading, toggling, and error states
 */
export function usePoke(
  profileId: string | undefined,
  isOwnProfile: boolean
): UsePokeReturn {
  const { t } = useTranslation();
  const [poked, setPoked] = useState(false);
  const [loading, setLoading] = useState(false);

  // Load poke status
  useEffect(() => {
    if (isOwnProfile || !profileId) return;

    let cancelled = false;

    const loadStatus = async () => {
      try {
        const { poked: isPoked } = await pokeService.getStatus(profileId);
        if (!cancelled) setPoked(!!isPoked);
      } catch {
        // Silently ignore errors
      }
    };

    loadStatus();

    return () => {
      cancelled = true;
    };
  }, [profileId, isOwnProfile]);

  // Toggle poke
  const toggle = useCallback(async () => {
    if (!profileId || loading || isOwnProfile) return;

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
