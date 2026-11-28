import {
  configurationMatchesBinding,
  type CheckoutConfiguration,
} from '@/lib/payments/checkoutConfiguration';
import { useEffect, useRef, useState } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { intentSource, PeableSheetCheckout, type SheetOutcome } from '@peable.to/sdk/checkout/ui';
import {
  observeEmbeddedSubscription,
  prepareEmbeddedCheckout,
  type EmbeddedCheckoutBinding,
} from '@/lib/payments/embeddedCheckout';
import { createLocalProviderTestBinding } from '@/lib/payments/localProviderTest';
import { checkoutMatchesReview, type CheckoutReview } from '@/lib/payments/checkoutReview';

/** How often a settled local subscription is asked whether it is active. */
const OBSERVE_MS = 3000;

/**
 * The local provider test: Mention Plus's subscription payment, prepared on
 * the press, paid in Peable's sheet (`PeableSheetCheckout`, the one /plus and
 * Mercaria use). Success is the subscription's own observation — active, its
 * first invoice paid — never the payment alone. No operation starts on page view.
 */
export function PreparedPlusCheckout({
  review,
  configuration,
  href,
  operationKey,
  initialBinding,
  onClose,
}: {
  review: CheckoutReview;
  configuration?: CheckoutConfiguration;
  href: string;
  operationKey: string;
  initialBinding?: EmbeddedCheckoutBinding;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const [binding, setBinding] = useState<EmbeddedCheckoutBinding>();
  const [settled, setSettled] = useState<'complete' | 'expired' | null>(null);
  const [active, setActive] = useState(false);
  // Expired is the gateway's own word; success is the subscription's observation.
  const outcome: SheetOutcome = settled === 'expired' ? 'failed' : active ? 'succeeded' : null;
  const [attempt, setAttempt] = useState(0);
  const failureMessage = useRef(t('plus.checkout.providerTest.bootstrapFailed'));
  failureMessage.current = t('plus.checkout.providerTest.bootstrapFailed');
  const retryLabel = useRef(t('common.retry'));
  retryLabel.current = t('common.retry');
  // Keep the created binding through a transient validation-read failure: retry
  // reads the same operation rather than creating another subscription.
  const created = useRef(initialBinding);
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  // Retry deliberately reruns preparation with the same scoped operation key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit retry trigger.
  useEffect(() => {
    const controller = new AbortController();
    let failureToast: string | number | undefined;
    void (async () => {
      try {
        const pending =
          created.current ??
          (await createLocalProviderTestBinding(
            operationKey,
            href,
            true,
            controller.signal,
            review.interval,
          ));
        if (controller.signal.aborted) return;
        created.current = pending;
        const ready = await prepareEmbeddedCheckout(pending, controller.signal);
        if (controller.signal.aborted) return;
        if (
          !checkoutMatchesReview(ready, review) ||
          (configurationRef.current &&
            !configurationMatchesBinding(configurationRef.current, ready))
        )
          throw new Error('Checkout terms changed');
        setBinding(ready);
      } catch {
        if (!controller.signal.aborted) {
          failureToast = toast(failureMessage.current, {
            type: 'error',
            action: {
              label: retryLabel.current,
              onClick: () => {
                if (!controller.signal.aborted) setAttempt((value) => value + 1);
              },
            },
          });
        }
      }
    })();
    return () => {
      controller.abort();
      if (failureToast !== undefined) toast.dismiss(failureToast);
    };
  }, [operationKey, review, attempt, href]);
  // A paid first invoice alone is not an active subscription: observe until it is.
  useEffect(() => {
    if (!binding || settled !== 'complete') return;
    let disposed = false;
    const observe = () => {
      observeEmbeddedSubscription(binding)
        .then((ready) => {
          if (!disposed && ready) setActive(true);
        })
        .catch(() => {
          // The next observation retries; the sheet stays on "confirming".
        });
    };
    observe();
    const timer = setInterval(observe, OBSERVE_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [binding, settled]);

  const source = binding ? intentSource(binding.intentId, binding.clientSecret) : null;
  if (!binding || !source) return null;
  return (
    <PeableSheetCheckout
      source={source}
      gatewayUrl={binding.apiUrl}
      locale={i18n.language}
      expected={{
        amount: String(review.amountMinorUnits),
        currency: review.currency,
        livemode: binding.livemode,
      }}
      order={{
        merchant: 'Mention',
        items: [
          {
            id: review.offerId,
            name: 'Mention Plus',
            detail: t(`plus.payment.cadence${review.interval === 'year' ? 'Year' : 'Month'}`),
            quantity: 1,
            amountMinorUnits: review.amountMinorUnits,
          },
        ],
        recurring: { interval: review.interval },
      }}
      returnUrl={href}
      onSettled={setSettled}
      outcome={outcome}
      onUnavailable={() => {
        toast(failureMessage.current, { type: 'error' });
        onClose();
      }}
      onClose={onClose}
    />
  );
}
