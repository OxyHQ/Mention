import { useQuery } from '@tanstack/react-query';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { plusOfferBinding, resolvePlusOffer } from '@/lib/payments/plusCheckout';

const binding = plusOfferBinding(
  process.env.EXPO_PUBLIC_MENTION_PLUS_OFFER_ID,
  process.env.EXPO_PUBLIC_MENTION_PLUS_OFFER_VERSION,
);
/** The card and payment dialog must describe exactly the same approved offer. */
export function usePlusOffer() {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const { activeSessionId } = useOxy();
  const enabled = !!binding && canUsePrivateApi && !!user?.id && !!activeSessionId;
  const query = useQuery({
    queryKey: ['viewer', user?.id, 'mention-plus-offer', activeSessionId, binding],
    queryFn: async () => resolvePlusOffer(await oxyServices.billing.personalPlans(), binding),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return {
    offer: enabled && !query.isError ? (query.data ?? null) : null,
    loading: enabled && query.isPending,
    failed: enabled && query.isError,
  };
}
