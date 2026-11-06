import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import {
  parseContract,
  productPlanCheckoutRequestCheck,
  subjectProductAccessQueryCheck,
} from '@oxy.so/contracts/client';
import { authenticatedApiCall } from '@oxy.so/core';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import {
  PeableSheetCheckout,
  SheetPreparationError,
  sheetSourceFromUrl,
  type SheetPreparedCheckout,
} from '@peable.to/sdk/checkout/ui';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  checkoutUrl,
  includesPlus,
  type PlusCadence,
  type PlusOffer,
  type PlusOfferBinding,
} from '@/lib/payments/plusCheckout';
import { clearPlusCheckoutKey, getPlusCheckoutKey } from '@/lib/payments/plusCheckoutStorage';

const OUTCOME_POLL_MS = 3000;
type Outcome = 'pending' | 'fulfilled' | 'closed' | 'review' | null;

/** Account/session changes discard the entire private controller and any late completion. */
export function PlusPaymentSheet({
  onClose,
  cadence = 'month',
}: {
  onClose(): void;
  cadence?: PlusCadence;
}) {
  const { user } = useAuth();
  const { activeSessionId } = useOxy();
  return (
    <PaymentContent
      key={`${user?.id}:${activeSessionId}:${cadence}`}
      onClose={onClose}
      cadence={cadence}
    />
  );
}

function PaymentContent({ onClose, cadence }: { onClose(): void; cadence: PlusCadence }) {
  const { user, oxyServices, canUsePrivateApi, signIn } = useAuth();
  const { activeSessionId } = useOxy();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const {
    offer: currentOffer,
    binding: currentBinding,
    loading,
    failed,
    hasAccess,
    purchaseAvailable,
  } = usePlusOffer(cadence);
  const [operation, setOperation] = useState<{
    offer: PlusOffer;
    binding: PlusOfferBinding;
  } | null>(null);
  const offer = operation?.offer ?? currentOffer;
  const binding = operation?.binding ?? currentBinding;
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [settled, setSettled] = useState(false);
  const scope = useRef({ active: false });
  const operationKey = useRef<string | null>(null);
  const pending = useRef(false);
  const started = useRef(false);
  const ownsBrowser = useRef(false);
  const reportedUnavailable = useRef(false);
  useLayoutEffect(() => {
    const current = { active: canUsePrivateApi };
    scope.current = current;
    return () => {
      current.active = false;
      if (ownsBrowser.current) WebBrowser.dismissBrowser();
    };
  }, [canUsePrivateApi]);
  useEffect(() => {
    if (started.current || loading || reportedUnavailable.current) return;
    const message = hasAccess
      ? 'included'
      : failed
        ? 'failed'
        : !offer
          ? 'unavailable'
          : !purchaseAvailable
            ? 'notReady'
            : null;
    if (!message) return;
    reportedUnavailable.current = true;
    toast(t(`plus.payment.${message}`), { type: message === 'included' ? 'success' : 'error' });
    onClose();
  }, [loading, failed, hasAccess, offer, purchaseAvailable, onClose, t]);

  /** Oxy owns both the durable operation and every access decision. This never charges a payment. */
  async function purchase(
    prepare: boolean,
    signal?: AbortSignal,
  ): Promise<SheetPreparedCheckout | undefined> {
    const attemptScope = scope.current;
    const isCurrent = () =>
      attemptScope.active && scope.current === attemptScope && !signal?.aborted;
    if (!offer?.price || !binding || !user?.id || !canUsePrivateApi || !isCurrent())
      throw new SheetPreparationError(t('plus.payment.signInRequired'), 'not_created');
    if (pending.current) throw new SheetPreparationError(t('plus.payment.pending'), 'unknown');
    pending.current = true;
    started.current = true;
    setOperation({ offer, binding });
    try {
      // Recheck bundle/standalone access on the explicit Continue, before opening any new order.
      if (prepare && !operationKey.current) {
        const access = await authenticatedApiCall(oxyServices, activeSessionId, () => {
          if (!isCurrent()) throw new Error('Account changed');
          return oxyServices.billing.productAccess(
            parseContract(subjectProductAccessQueryCheck, {
              schemaVersion: 1,
              subjectAccountId: user.id,
              productId: offer.productId,
            }),
          );
        });
        if (!isCurrent()) return;
        if (includesPlus(access, user.id, binding)) {
          toast(t('plus.payment.included'), { type: 'success' });
          onClose();
          return;
        }
      }
      operationKey.current ??= await getPlusCheckoutKey(user.id, binding);
      if (!isCurrent()) return;
      const key = operationKey.current;
      const result = await authenticatedApiCall(oxyServices, activeSessionId, () => {
        if (!isCurrent()) throw new Error('Account changed');
        return oxyServices.billing.startProductPlanCheckout(
          parseContract(productPlanCheckoutRequestCheck, {
            expectedSubjectAccountId: user.id,
            productId: offer.productId,
            offerId: offer.offerId,
            offerVersion: offer.offerVersion,
            idempotencyKey: key,
          }),
        );
      });
      if (!isCurrent()) return;
      if (result.state === 'pending') {
        setOutcome('pending');
        if (!prepare) return;
        const source = result.checkoutUrl
          ? sheetSourceFromUrl(checkoutUrl(result.checkoutUrl))
          : null;
        if (source?.type !== 'checkout_session')
          throw new SheetPreparationError(t('plus.payment.pending'), 'unknown');
        return {
          source,
          expected: {
            amount: String(offer.price.amountMinorUnits),
            currency: offer.price.currency,
          },
        };
      }
      if (result.state === 'closed' || result.state === 'fulfilled') {
        // Clear only this terminal key; a newer operation from another tab must survive.
        await clearPlusCheckoutKey(user.id, binding, key).catch(() => undefined);
        if (!isCurrent()) return;
      }
      if (result.state === 'fulfilled') {
        setOutcome('fulfilled');
        await queryClient
          .invalidateQueries({
            queryKey: viewerQueryKeys.mentionPersonalization(
              user.id,
              activeSessionId,
              canUsePrivateApi,
            ),
          })
          .catch(() => undefined);
        if (isCurrent())
          await queryClient
            .invalidateQueries({
              queryKey: viewerQueryKeys.mentionPlusAccess(
                user.id,
                activeSessionId,
                binding.productId,
                binding.capabilityKey,
              ),
            })
            .catch(() => undefined);
        if (prepare && isCurrent()) {
          toast(t('plus.payment.fulfilled'), { type: 'success' });
          onClose();
        }
        return;
      }
      if (result.state === 'closed') setOutcome('closed');
      if (!prepare && result.state === 'unconfigured') {
        setOutcome('review');
        toast(t('plus.payment.unavailable'), { type: 'error' });
        onClose();
        return;
      }
      throw new SheetPreparationError(
        t(`plus.payment.${result.state === 'unconfigured' ? 'unavailable' : result.state}`),
        'unknown',
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof SheetPreparationError) throw error;
      const reviewRequired =
        error instanceof Error &&
        (error.message === 'PAYMENT_REVIEW_REQUIRED' ||
          ('code' in error && error.code === 'PAYMENT_REVIEW_REQUIRED'));
      if (reviewRequired) {
        setOutcome('review');
        if (!prepare) {
          toast(t('plus.payment.review'), { type: 'error' });
          onClose();
          return;
        }
      }
      throw new SheetPreparationError(
        t(reviewRequired ? 'plus.payment.review' : 'plus.payment.failed'),
        'unknown',
      );
    } finally {
      if (scope.current === attemptScope) pending.current = false;
    }
  }
  // The sheet finishing never grants Plus: poll Oxy's authoritative operation until it settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: purchase reads the current account scope and frozen offer.
  useEffect(() => {
    if (!settled || outcome !== 'pending') return;
    const timer = setInterval(() => {
      void purchase(false).catch(() => undefined);
    }, OUTCOME_POLL_MS);
    return () => clearInterval(timer);
  }, [settled, outcome]);

  if (!offer?.price || !binding) return null;
  const price = offer.price;
  return (
    <PeableSheetCheckout
      preparation={{
        key: `${user?.id}:${activeSessionId}:${binding.offerId}:${binding.offerVersion}`,
        request: {
          merchant: 'Mention',
          currency: price.currency,
          dueTodayMinorUnits: price.amountMinorUnits,
          items: [
            {
              id: offer.offerId,
              name: offer.displayName,
              detail: t(`plus.payment.cadence${price.interval === 'year' ? 'Year' : 'Month'}`),
              quantity: 1,
              amountMinorUnits: price.amountMinorUnits,
            },
          ],
          recurring: { amountMinorUnits: price.amountMinorUnits, interval: price.interval },
          requiresShipping: false,
          requiresContact: false,
          paymentMethods: price.currency === 'FAIR' ? ['faircoin'] : ['card', 'faircoin'],
        },
        initialDetails: { email: user?.email ?? '' },
        ...(user
          ? {
              accountSummary: {
                name: user.name?.displayName ?? user.username ?? 'Oxy',
                ...(user.email ? { detail: user.email } : {}),
              },
            }
          : {}),
        ...(!canUsePrivateApi
          ? {
              renderAdditionalDetails: () => (
                <Button
                  onPress={() => {
                    void signIn();
                  }}
                >
                  {t('plus.payment.signIn')}
                </Button>
              ),
            }
          : {}),
        canContinue: canUsePrivateApi && (started.current || (purchaseAvailable && !hasAccess)),
        createSession: async (_details, { signal }) => {
          const result = await purchase(true, signal);
          if (!result) throw new SheetPreparationError(t('plus.payment.pending'), 'unknown');
          return result;
        },
      }}
      locale={i18n.language}
      presentation={{
        merchant: 'Mention',
        recurring: { interval: price.interval },
        itemDetail: () => t(`plus.payment.cadence${price.interval === 'year' ? 'Year' : 'Month'}`),
      }}
      openUrl={async (url, kind) => {
        if (!scope.current.active) return;
        if (kind === 'wallet') {
          if (Platform.OS === 'web') window.location.href = url;
          else await Linking.openURL(url);
          return;
        }
        if (Platform.OS === 'web') {
          const page = window.open('about:blank', '_blank');
          if (!page) toast(t('plus.payment.blocked'), { type: 'error' });
          else {
            page.opener = null;
            page.location.replace(url);
          }
          return;
        }
        ownsBrowser.current = true;
        try {
          await WebBrowser.openBrowserAsync(url);
        } finally {
          ownsBrowser.current = false;
        }
      }}
      onSettled={() => {
        setSettled(true);
        void purchase(false).catch(() => undefined);
      }}
      outcome={outcome === 'fulfilled' ? 'succeeded' : outcome === 'closed' ? 'failed' : null}
      onUnavailable={() => {
        toast(t('plus.payment.failed'), { type: 'error' });
        onClose();
      }}
      onClose={onClose}
    />
  );
}
