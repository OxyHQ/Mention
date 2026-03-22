import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { show as toast } from '@oxyhq/bloom/toast';
import { useAuth } from '@oxyhq/services';
import { pokeService } from '@/services/pokeService';
import { useDeferredToggle } from './useDeferredToggle';

export interface UsePokeReturn {
  poked: boolean;
  loading: boolean;
  toggle: () => Promise<void>;
}

/**
 * Hook for managing poke state on a profile.
 * Defers the initial status fetch to avoid blocking profile render.
 */
export function usePoke(
  profileId: string | undefined,
  isOwnProfile: boolean
): UsePokeReturn {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();

  const fetchStatus = useCallback(async () => {
    if (!profileId) return false;
    const { poked } = await pokeService.getStatus(profileId);
    return !!poked;
  }, [profileId]);

  const onEnable = useCallback(async () => {
    if (!profileId) return;
    await pokeService.poke(profileId);
    toast(t('poke.sent', { defaultValue: 'Poked!' }), { type: 'success' });
  }, [profileId, t]);

  const onDisable = useCallback(async () => {
    if (!profileId) return;
    await pokeService.unpoke(profileId);
    toast(t('poke.undone', { defaultValue: 'Poke undone' }), { type: 'success' });
  }, [profileId, t]);

  const { active, loading, toggle } = useDeferredToggle({
    skip: isOwnProfile || !profileId || !isAuthenticated,
    fetchStatus,
    onEnable,
    onDisable,
  });

  // Wrap toggle to handle errors with toast
  const safeToggle = useCallback(async () => {
    try {
      await toggle();
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || t('poke.error', { defaultValue: 'Failed to poke' });
      toast(errorMessage, { type: 'error' });
    }
  }, [toggle, t]);

  return {
    poked: active,
    loading,
    toggle: safeToggle,
  };
}
