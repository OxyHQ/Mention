import {
  configurationMatchesReview,
  configurationMatchesBinding,
  type CheckoutConfiguration,
} from '@/lib/payments/checkoutConfiguration';
import { useEffect, useRef, useState } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import {
  prepareEmbeddedCheckout,
  type EmbeddedCheckoutBinding,
} from '@/lib/payments/embeddedCheckout';
import { createLocalProviderTestBinding } from '@/lib/payments/localProviderTest';
import { checkoutMatchesReview, type CheckoutReview } from '@/lib/payments/checkoutReview';
import { PeableEmbeddedCheckout } from './PeableEmbeddedCheckout';

/** One mounted sheet for review, preparation and authorization. No operation starts on page view. */
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
  const { t } = useTranslation();
  const [binding, setBinding] = useState<EmbeddedCheckoutBinding>();
  const [failed, setFailed] = useState(false);
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
    setFailed(false);
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
          setFailed(true);
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
  return (
    <PeableEmbeddedCheckout
      binding={binding}
      review={review}
      configuration={
        configuration &&
        configurationMatchesReview(configuration, review) &&
        (!binding || configurationMatchesBinding(configuration, binding))
          ? configuration
          : undefined
      }
      onClose={onClose}
      onRetry={failed ? () => setAttempt((value) => value + 1) : undefined}
    />
  );
}
