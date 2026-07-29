import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxyhq/bloom/toast';
import { subscriptionService } from '@/services/subscriptionService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { normalizeApiError } from '@/utils/apiError';
import { useDeferredToggle } from './useDeferredToggle';
import type { UseSubscriptionReturn } from '../types';

/**
 * Hook for managing profile subscription state.
 * Defers the initial status fetch to avoid blocking profile render.
 *
 * Both toggle directions invalidate the viewer's subscription LIST so the
 * settings screen and this bell can never disagree — the list is the only other
 * reader of the same server state, and it holds a full page of rows this hook
 * cannot patch precisely.
 */
export function useSubscription(
  profileId: string | undefined,
  currentUserId: string | undefined,
  isOwnProfile: boolean
): UseSubscriptionReturn {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const invalidateSubscriptionList = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: viewerQueryKeys.subscriptions(currentUserId) });
  }, [queryClient, currentUserId]);

  const fetchStatus = useCallback(async () => {
    if (!profileId) return false;
    const { subscribed } = await subscriptionService.getStatus(profileId);
    return !!subscribed;
  }, [profileId]);

  const onEnable = useCallback(async () => {
    if (!profileId) return;
    await subscriptionService.subscribe(profileId);
    invalidateSubscriptionList();
    toast(t('subscription.subscribed'), { type: 'success' });
  }, [profileId, invalidateSubscriptionList, t]);

  const onDisable = useCallback(async () => {
    if (!profileId) return;
    await subscriptionService.unsubscribe(profileId);
    invalidateSubscriptionList();
    toast(t('subscription.unsubscribed'), { type: 'success' });
  }, [profileId, invalidateSubscriptionList, t]);

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
    } catch (error: unknown) {
      const errorMessage = normalizeApiError(error).message || t('subscription.error');
      toast(errorMessage, { type: 'error' });
    }
  }, [toggle, t]);

  return {
    subscribed: active,
    loading,
    toggle: safeToggle,
  };
}
