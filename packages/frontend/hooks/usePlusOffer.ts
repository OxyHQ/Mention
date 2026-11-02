import {
  MENTION_PLUS_OFFER_ID,
  MENTION_PLUS_ANNUAL_OFFER_ID,
  MENTION_PLUS_ANNUAL_OFFER_VERSION,
  MENTION_PLUS_OFFER_VERSION,
  MENTION_PLUS_PRODUCT_ID,
  MENTION_PLUS_CAPABILITY_KEY,
} from '@/config';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { parseContract, subjectProductAccessQueryCheck } from '@oxy.so/contracts/client';
import {
  includesPlus,
  plusOfferBinding,
  resolvePlusCadenceOffer,
  type PlusCadence,
} from '@/lib/payments/plusCheckout';

export const mentionPlusBinding = plusOfferBinding(
  MENTION_PLUS_OFFER_ID,
  MENTION_PLUS_OFFER_VERSION,
  MENTION_PLUS_PRODUCT_ID,
  MENTION_PLUS_CAPABILITY_KEY,
);
export const mentionPlusBindings = {
  month: mentionPlusBinding,
  year: plusOfferBinding(
    MENTION_PLUS_ANNUAL_OFFER_ID,
    MENTION_PLUS_ANNUAL_OFFER_VERSION,
    MENTION_PLUS_PRODUCT_ID,
    MENTION_PLUS_CAPABILITY_KEY,
  ),
};
const accessBinding =
  MENTION_PLUS_PRODUCT_ID && MENTION_PLUS_CAPABILITY_KEY
    ? { productId: MENTION_PLUS_PRODUCT_ID, capabilityKey: MENTION_PLUS_CAPABILITY_KEY }
    : null;
/** Public pricing is independent of sign-in; both individual and bundle access are authoritative. */
export function usePlusOffer(cadence: PlusCadence = 'month') {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const { activeSessionId } = useOxy();
  const binding = mentionPlusBindings[cadence];
  const query = useQuery({
    queryKey: viewerQueryKeys.mentionPlusOffer(
      undefined,
      undefined,
      binding?.productId,
      binding?.offerId,
      binding?.offerVersion,
      mentionPlusBindings.month?.offerId,
      mentionPlusBindings.month?.offerVersion,
    ),
    queryFn: async () =>
      binding
        ? resolvePlusCadenceOffer(
            await oxyServices.billing.productPlans(binding.productId),
            cadence,
            mentionPlusBindings,
          )
        : null,
    enabled: !!binding,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const accessEnabled = !!accessBinding && canUsePrivateApi && !!user?.id && !!activeSessionId;
  const access = useQuery({
    queryKey: viewerQueryKeys.mentionPlusAccess(
      user?.id,
      activeSessionId,
      accessBinding?.productId,
      accessBinding?.capabilityKey,
    ),
    queryFn: async () => {
      if (!accessBinding || !user?.id) throw new Error('Sign in required');
      return includesPlus(
        await oxyServices.billing.productAccess(
          parseContract(subjectProductAccessQueryCheck, {
            schemaVersion: 1,
            subjectAccountId: user.id,
            productId: accessBinding.productId,
          }),
        ),
        user.id,
        accessBinding,
      );
    },
    enabled: accessEnabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return {
    binding,
    offer: binding && !query.isError ? (query.data ?? null) : null,
    loading: !!binding && query.isPending,
    failed: !!binding && query.isError,
    hasAccess: accessEnabled && !access.isError && access.data === true,
    checkingAccess: accessEnabled && access.isPending,
    accessFailed: accessEnabled && access.isError,
  };
}
