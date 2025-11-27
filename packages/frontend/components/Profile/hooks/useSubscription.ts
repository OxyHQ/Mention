import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { subscriptionService } from '@/services/subscriptionService';
import type { UseSubscriptionReturn } from '../types';

/**
 * Hook for managing profile subscription state
 * Handles loading, toggling, and error states for subscriptions
 */
export function useSubscription(
  profileId: string | undefined,
  currentUserId: string | undefined,
  isOwnProfile: boolean
): UseSubscriptionReturn {
  const { t } = useTranslation();
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);

  // Load subscription status
  useEffect(() => {
    if (isOwnProfile || !profileId || !currentUserId) return;

    let cancelled = false;

    const loadStatus = async () => {
      try {
        const { subscribed: isSubscribed } = await subscriptionService.getStatus(profileId);
        if (!cancelled) setSubscribed(!!isSubscribed);
      } catch (error: any) {
        // Silently ignore 401 errors (user not authenticated)
        if (error?.response?.status !== 401) {
          console.error('Error loading subscription status:', error);
        }
      }
    };

    loadStatus();

    return () => {
      cancelled = true;
    };
  }, [profileId, isOwnProfile, currentUserId]);

  // Toggle subscription
  const toggle = useCallback(async () => {
    if (!profileId || loading || isOwnProfile) return;

    setLoading(true);
    const previousState = subscribed;
    setSubscribed(!previousState);

    try {
      if (!previousState) {
        await subscriptionService.subscribe(profileId);
        toast.success(t('subscription.subscribed'));
      } else {
        await subscriptionService.unsubscribe(profileId);
        toast.success(t('subscription.unsubscribed'));
      }
    } catch (error: any) {
      // Revert on error
      setSubscribed(previousState);
      const errorMessage = error?.response?.data?.message || error?.message || t('subscription.error');
      toast.error(errorMessage);
      console.error('Error toggling subscription:', error);
    } finally {
      setLoading(false);
    }
  }, [profileId, loading, subscribed, isOwnProfile, t]);

  return {
    subscribed,
    loading,
    toggle,
  };
}



