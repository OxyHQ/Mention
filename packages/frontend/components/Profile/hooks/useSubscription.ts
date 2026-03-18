import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { subscriptionService } from '@/services/subscriptionService';
import type { UseSubscriptionReturn } from '../types';

const LAZY_FETCH_DELAY_MS = 500;

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
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);
  const subscribedRef = useRef(subscribed);
  subscribedRef.current = subscribed;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Defer subscription status fetch — non-critical data
  useEffect(() => {
    if (isOwnProfile || !profileId || !currentUserId) return;

    fetchedRef.current = false;
    let cancelled = false;

    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      try {
        const { subscribed: isSubscribed } = await subscriptionService.getStatus(profileId);
        if (!cancelled) {
          setSubscribed(!!isSubscribed);
          fetchedRef.current = true;
        }
      } catch {
        // Silently ignore errors (including 401 for unauthenticated users)
      }
    }, LAZY_FETCH_DELAY_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [profileId, isOwnProfile, currentUserId]);

  // Toggle subscription — fetches status first if not yet loaded
  const toggle = useCallback(async () => {
    if (!profileId || loading || isOwnProfile) return;

    // Cancel the deferred timer to prevent concurrent fetches
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // If we haven't fetched yet, fetch now and use the result directly
    if (!fetchedRef.current) {
      try {
        const { subscribed: isSubscribed } = await subscriptionService.getStatus(profileId);
        setSubscribed(!!isSubscribed);
        subscribedRef.current = !!isSubscribed;
        fetchedRef.current = true;
      } catch {
        // Continue with default state
      }
    }

    setLoading(true);
    // Read from ref to get the latest value (not stale closure)
    const previousState = subscribedRef.current;
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
      setSubscribed(previousState);
      const errorMessage = error?.response?.data?.message || error?.message || t('subscription.error');
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [profileId, loading, isOwnProfile, t]);

  return {
    subscribed,
    loading,
    toggle,
  };
}
