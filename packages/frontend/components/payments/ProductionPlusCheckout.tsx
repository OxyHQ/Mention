import type { SessionCheckoutPreparation } from '@/lib/payments/sessionCheckout';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { authenticatedApiCall } from '@oxy.so/core';
import {
  parseContract,
  productPlanCheckoutRequestCheck,
  personalPlanCheckoutResultCheck,
  subjectProductAccessQueryCheck,
} from '@oxy.so/contracts/client';
import type { CheckoutBillingAddress, ProductPlanCheckoutRequest } from '@oxy.so/contracts';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import type { CheckoutReview } from '@/lib/payments/checkoutReview';
import type { useProductionCheckoutConfiguration } from '@/hooks/useProductionCheckoutConfiguration';
import {
  productionPresentation,
  productionSessionBinding,
} from '@/lib/payments/productionCheckout';
import { clearPlusCheckoutKey, getPlusCheckoutKey } from '@/lib/payments/plusCheckoutStorage';
import { includesPlus, type PlusOfferBinding } from '@/lib/payments/plusCheckout';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { PeableEmbeddedCheckout } from './PeableEmbeddedCheckout';
import {
  CheckoutBillingAddress as AddressFields,
  billingAddressComplete,
  emptyBillingAddress,
} from './CheckoutBillingAddress';

/** Memory-only payer capability and address; the durable operation stores only its opaque key. */
export function ProductionPlusCheckout({
  review,
  offerBinding,
  configuration,
  onClose,
}: {
  review: CheckoutReview;
  offerBinding: PlusOfferBinding;
  configuration: ReturnType<typeof useProductionCheckoutConfiguration>;
  onClose(): void;
}) {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const { activeSessionId } = useOxy();
  const queries = useQueryClient();
  const caller = useMemo(
    () => ({ active: canUsePrivateApi, subject: user?.id, sessionId: activeSessionId }),
    [user?.id, activeSessionId, canUsePrivateApi],
  );
  const currentCaller = useRef(caller);
  useLayoutEffect(() => {
    caller.active = canUsePrivateApi;
    currentCaller.current = caller;
    return () => {
      caller.active = false;
    };
  }, [caller, canUsePrivateApi]);
  const accountEmail = typeof user?.email === 'string' ? user.email.trim() : '';
  const [receiptEmail, setReceiptEmail] = useState(accountEmail);
  const validEmail = receiptEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiptEmail);
  const [address, setAddress] = useState(emptyBillingAddress);
  const [locked, setLocked] = useState(false);
  const addressLocked = useRef(false);
  const alive = useRef(true);
  const request = useRef<ProductPlanCheckoutRequest | undefined>(undefined);
  const completed = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current = undefined;
    };
  }, []);
  const current = () =>
    alive.current &&
    caller.active &&
    currentCaller.current === caller &&
    canUsePrivateApi &&
    !!user?.id &&
    !!activeSessionId;
  const call = async (body: ProductPlanCheckoutRequest) => {
    if (!current()) throw new Error('Account changed');
    const result = await authenticatedApiCall(oxyServices, activeSessionId, () => {
      if (!current()) throw new Error('Account changed');
      return oxyServices.billing.startProductPlanCheckout(body);
    });
    if (!current()) throw new Error('Account changed');
    return parseContract(personalPlanCheckoutResultCheck, result);
  };
  const fulfilled = async () => {
    if (!current() || completed.current || !user?.id || !request.current) return;
    completed.current = true;
    await clearPlusCheckoutKey(user.id, offerBinding, request.current.idempotencyKey, 'embedded');
    if (!current()) return;
    await Promise.all([
      queries.invalidateQueries({
        queryKey: viewerQueryKeys.mentionPlusAccess(
          user.id,
          activeSessionId,
          offerBinding.productId,
          offerBinding.capabilityKey,
        ),
      }),
      queries.invalidateQueries({
        queryKey: viewerQueryKeys.mentionPersonalization(
          user.id,
          activeSessionId,
          canUsePrivateApi,
        ),
      }),
    ]);
  };
  const prepare = async (): Promise<SessionCheckoutPreparation> => {
    if (
      !current() ||
      !user?.id ||
      !configuration ||
      (!request.current && configuration.fetchedAt + 60_000 <= Date.now()) ||
      !billingAddressComplete(address) ||
      !validEmail
    )
      throw new Error('Checkout prerequisites are unavailable');
    addressLocked.current = true;
    setLocked(true);
    if (!request.current) {
      const access = await authenticatedApiCall(oxyServices, activeSessionId, () =>
        oxyServices.billing.productAccess(
          parseContract(subjectProductAccessQueryCheck, {
            schemaVersion: 1,
            subjectAccountId: user.id,
            productId: review.productId,
          }),
        ),
      );
      if (!current()) throw new Error('Account changed');
      if (includesPlus(access, user.id, offerBinding)) {
        onClose();
        throw new Error('Access already included');
      }
      const idempotencyKey = await getPlusCheckoutKey(user.id, offerBinding, 'embedded');
      if (!current()) throw new Error('Account changed');
      const billingAddress: CheckoutBillingAddress = { country: address.country };
      for (const field of ['state', 'postalCode', 'city', 'line1', 'line2'] as const) {
        const value = address[field].trim();
        if (value) billingAddress[field] = value;
      }
      request.current = parseContract(productPlanCheckoutRequestCheck, {
        expectedSubjectAccountId: user.id,
        productId: review.productId,
        offerId: review.offerId,
        offerVersion: review.offerVersion,
        idempotencyKey,
        presentation: 'embedded',
        billingAddress,
      });
    }
    const result = await call(request.current);
    if (result.state === 'fulfilled') {
      await fulfilled();
      if (current()) onClose();
      throw new Error('Checkout already fulfilled');
    }
    if (result.state === 'pending' && result.checkoutStatus === 'complete')
      return { state: 'awaiting_fulfillment' };
    if (result.state !== 'pending' || !result.embeddedCheckout)
      throw new Error('Embedded checkout unavailable');
    return productionSessionBinding(
      result.embeddedCheckout,
      configuration.configuration,
      user.id,
      review,
    );
  };
  const observe = async () => {
    if (!request.current || !current()) return false;
    const result = await call(request.current);
    if (result.state !== 'fulfilled') return false;
    await fulfilled();
    return current();
  };
  return (
    <PeableEmbeddedCheckout
      review={review}
      configuration={
        configuration && configuration.fetchedAt + 60_000 > Date.now()
          ? productionPresentation(configuration.configuration, review, configuration.fetchedAt)
          : undefined
      }
      prepareSession={prepare}
      observeSession={observe}
      billingComplete={billingAddressComplete(address) && validEmail}
      billingDetails={{
        country: address.country,
        postcode: address.postalCode,
        email: receiptEmail,
      }}
      billingContent={
        <AddressFields
          value={address}
          locked={locked}
          receiptEmail={accountEmail ? undefined : receiptEmail}
          onReceiptEmailChange={(email) => {
            if (!addressLocked.current) setReceiptEmail(email);
          }}
          onChange={(next) => {
            if (!addressLocked.current) setAddress(next);
          }}
        />
      }
      onClose={onClose}
    />
  );
}
