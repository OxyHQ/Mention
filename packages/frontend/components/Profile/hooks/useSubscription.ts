import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { subscriptionService } from '@/services/subscriptionService';
import { useDeferredToggle } from './useDeferredToggle';
import type { UseSubscriptionReturn } from '../types';

/**
 * Hook for managing profile subscription state.
 * Defers the initial status fetch to avoid blocking profile render.
 */
export function useSubscription(
  profileId: string | undefined,
  currentUserId: string | undefined,
  isOwnProfile: boolean
): UseSubscriptionReturn {
  const { t } = useTranslation();

  const fetchStatus = useCallback(async () => {
    if (!profileId) return false;
    const { subscribed } = await subscriptionService.getStatus(profileId);
    return !!subscribed;
  }, [profileId]);

  const onEnable = useCallback(async () => {
    if (!profileId) return;
    await subscriptionService.subscribe(profileId);
    toast.success(t('subscription.subscribed'));
  }, [profileId, t]);

  const onDisable = useCallback(async () => {
    if (!profileId) return;
    await subscriptionService.unsubscribe(profileId);
    toast.success(t('subscription.unsubscribed'));
  }, [profileId, t]);

  const { active, loading, toggle } = useDeferredToggle({
    skip: isOwnProfile || !profileId || !currentUserId,
    fetchStatus,
    onEnable,
    onDisable,
  });

  // Wrap toggle to handle errors with toast
  const safeToggle = useCallback(async () => {
    try {
      await toggle();
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || t('subscription.error');
      toast.error(errorMessage);
    }
  }, [toggle, t]);

  return {
    subscribed: active,
    loading,
    toggle: safeToggle,
  };
}
