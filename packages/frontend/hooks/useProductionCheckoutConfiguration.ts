import { loadProviderSdk } from '@peable.to/sdk/checkout';
import { authenticatedApiCall } from '@oxy.so/core';
import { parseContract, productCheckoutConfigurationCheck } from '@oxy.so/contracts/client';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { CheckoutReview } from '@/lib/payments/checkoutReview';
import { matchingProductionConfiguration } from '@/lib/payments/productionCheckout';

/** Authenticated public configuration only: no customer, subscription or payer secret on page view. */
export function useProductionCheckoutConfiguration(
  enabled: boolean,
  review: CheckoutReview | null,
  scope: string,
) {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const { activeSessionId } = useOxy();
  const query = useQuery({
    queryKey: viewerQueryKeys.checkoutConfiguration(
      user?.id,
      activeSessionId,
      `production:${scope}`,
    ),
    enabled: enabled && canUsePrivateApi && !!user?.id && !!activeSessionId && !!review,
    queryFn: async () => {
      if (!user?.id || !review || !activeSessionId) throw new Error('Sign in required');
      const configuration = parseContract(
        productCheckoutConfigurationCheck,
        await authenticatedApiCall(oxyServices, activeSessionId, () =>
          oxyServices.billing.productCheckoutConfiguration(review.productId, user.id),
        ),
      );
      if (!matchingProductionConfiguration(configuration, user.id, review)) return null;
      void loadProviderSdk().catch(() => {});
      return { configuration, fetchedAt: Date.now() };
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 45_000,
  });
  return enabled && !query.isError && query.data && query.data.fetchedAt + 60_000 > Date.now()
    ? query.data
    : undefined;
}
