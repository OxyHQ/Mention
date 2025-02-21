import { useState, useEffect } from 'react';
import { subscriptionService } from '../services/subscription.service';
import { useAuth } from './useAuth';

interface SubscriptionState {
  loading: boolean;
  error: string | null;
  plan: 'basic' | 'pro' | 'business';
  features: {
    analytics: boolean;
    premiumBadge: boolean;
    unlimitedFollowing: boolean;
    higherUploadLimits: boolean;
    promotedPosts: boolean;
    businessTools: boolean;
  };
}

export const useSubscription = () => {
  const { user } = useAuth();
  const [state, setState] = useState<SubscriptionState>({
    loading: true,
    error: null,
    plan: 'basic',
    features: {
      analytics: false,
      premiumBadge: false,
      unlimitedFollowing: false,
      higherUploadLimits: false,
      promotedPosts: false,
      businessTools: false,
    },
  });

  useEffect(() => {
    const loadSubscription = async () => {
      if (!user?.id) {
        setState(prev => ({ ...prev, loading: false }));
        return;
      }

      try {
        setState(prev => ({ ...prev, loading: true, error: null }));
        const subscription = await subscriptionService.getSubscription(user.id);
        setState(prev => ({
          ...prev,
          loading: false,
          plan: subscription.plan,
          features: subscription.features,
        }));
      } catch (error) {
        setState(prev => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load subscription',
        }));
      }
    };

    loadSubscription();
  }, [user?.id]);

  const updateSubscription = async (plan: 'basic' | 'pro' | 'business') => {
    if (!user?.id) return;

    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      const subscription = await subscriptionService.updateSubscription(user.id, plan);
      setState(prev => ({
        ...prev,
        loading: false,
        plan: subscription.plan,
        features: subscription.features,
      }));
      return subscription;
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to update subscription',
      }));
      throw error;
    }
  };

  const cancelSubscription = async () => {
    if (!user?.id) return;

    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      await subscriptionService.cancelSubscription(user.id);
      setState(prev => ({
        ...prev,
        loading: false,
        plan: 'basic',
        features: {
          analytics: false,
          premiumBadge: false,
          unlimitedFollowing: false,
          higherUploadLimits: false,
          promotedPosts: false,
          businessTools: false,
        },
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to cancel subscription',
      }));
      throw error;
    }
  };

  return {
    ...state,
    updateSubscription,
    cancelSubscription,
  };
};