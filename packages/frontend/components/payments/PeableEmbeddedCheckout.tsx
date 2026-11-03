import type { CheckoutReview } from '@/lib/payments/checkoutReview';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { createPeableCheckout, type PeableClientAction } from '@peable.to/sdk/checkout';
import {
  PeableCheckoutSheet,
  PeableProviderFields,
  type ProviderCardPreparation,
  type PreparedCardAuthorization,
  type CheckoutCard,
  type CheckoutStep,
} from '@peable.to/sdk/checkout/ui';
import { emptyCheckoutDraft } from '@oxy.so/bloom/checkout-sheet/model';
import { useTranslation } from 'react-i18next';
import { useCheckoutFeedback } from '@/hooks/useCheckoutFeedback';
import {
  providerActionMatchesEnvironment,
  observeEmbeddedSubscription,
  embeddedCheckoutPhase,
  type EmbeddedCheckoutBinding,
} from '@/lib/payments/embeddedCheckout';

type Intent = Awaited<ReturnType<ReturnType<typeof createPeableCheckout>['getPaymentIntent']>>;
/** One payer checkout view; environment-specific credentials and billing authority come from its host. */
export function PeableEmbeddedCheckout({
  binding,
  review,
  onRetry,
  onClose,
}: {
  binding?: EmbeddedCheckoutBinding;
  review?: CheckoutReview;
  onRetry?: () => void;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const client = useMemo(
    () => (binding ? createPeableCheckout({ gatewayUrl: binding.apiUrl }) : null),
    [binding],
  );
  const [intent, setIntent] = useState<Intent | null>(binding?.initial?.intent ?? null);
  const [action, setAction] = useState<PeableClientAction | null>(binding?.initial?.action ?? null);
  const [step, setStep] = useState<CheckoutStep>('review');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const active = useRef(true);
  const inFlight = useRef(false);
  const terminal = useRef<'success' | 'failure' | null>(null);
  const subscriptionReady = useRef(!binding?.subscription);
  const prepareRef = useRef<(() => Promise<ProviderCardPreparation>) | null>(null);
  const authorizationRef = useRef<PreparedCardAuthorization | null>(null);
  const [preparedCard, setPreparedCard] = useState<CheckoutCard | null>(null);
  useEffect(() => () => authorizationRef.current?.dispose(), []);
  const feedback = useCheckoutFeedback(true);
  const sounded = useRef(false);
  const failedSeen = useRef(false);
  const closed = useRef(false);
  const [restoredBrand, setRestoredBrand] = useState(false);
  const completion = useRef({ onClose, stop: feedback.stop });
  completion.current = { onClose, stop: feedback.stop };
  useEffect(() => {
    if (step !== 'success') {
      setRestoredBrand(false);
      return;
    }
    const restore = setTimeout(() => {
      if (active.current) setRestoredBrand(true);
    }, 1500);
    const dismiss = setTimeout(() => {
      if (active.current && !closed.current) {
        closed.current = true;
        completion.current.stop();
        completion.current.onClose();
      }
    }, 1800);
    return () => {
      clearTimeout(restore);
      clearTimeout(dismiss);
    };
  }, [step]);
  const prefix = 'plus.checkout.providerTest.';
  useEffect(() => {
    active.current = true;
    if (!binding || !client)
      return () => {
        active.current = false;
      };
    subscriptionReady.current = !binding.subscription;
    if (binding.initial) {
      setIntent(binding.initial.intent);
      setAction(binding.initial.action);
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const update = (value: Intent) => {
      if (disposed || value.id !== binding.intentId) return;
      if (
        value.rail !== 'card' ||
        value.currency !== 'USD' ||
        !/^\d+$/.test(value.amount) ||
        !Number.isSafeInteger(Number(value.amount)) ||
        Number(value.amount) <= 0 ||
        (binding.subscription &&
          (Number(value.amount) !== binding.subscription.amountMinorUnits ||
            value.currency !== binding.subscription.currency))
      ) {
        setError(t(`${prefix}invalid`));
        setAction(null);
        setReady(false);
        return;
      }
      if (terminal.current) return;
      setIntent(value);
      setError(null);
      const phase = embeddedCheckoutPhase(value.status);
      if (phase === 'success' && !subscriptionReady.current) {
        if (!inFlight.current) setStep('processing');
        return;
      }
      if (phase === 'success') {
        terminal.current = 'success';
        setStep('success');
        if (!sounded.current) {
          sounded.current = true;
          feedback.play('success', 1);
        }
      } else if (phase === 'failure') {
        terminal.current = 'failure';
        setStep('failure');
      } else if (phase === 'pending' && !inFlight.current) setStep('processing');
      else if (value.status === 'failed' && !failedSeen.current && !inFlight.current) {
        failedSeen.current = true;
        setAccepted(false);
        authorizationRef.current?.dispose();
        authorizationRef.current = null;
        setPreparedCard(null);
        setStep('card');
        setError(t(`${prefix}declined`));
      }
    };
    let readTask: Promise<Intent | null> | undefined;
    const read = (): Promise<Intent | null> => {
      if (readTask) return readTask;
      readTask = (async () => {
        try {
          const value = await client.getPaymentIntent(binding.intentId, binding.clientSecret);
          if (binding.subscription) {
            const ready = await observeEmbeddedSubscription(binding);
            if (disposed) return null;
            subscriptionReady.current ||= ready;
          }
          update(value);
          return value;
        } catch {
          if (!disposed) setError(t(`${prefix}connection`));
          return null;
        }
      })().finally(() => {
        readTask = undefined;
      });
      return readTask;
    };
    void (async () => {
      const first = await read();
      if (
        disposed ||
        !first ||
        first.rail !== 'card' ||
        embeddedCheckoutPhase(first.status) === 'success' ||
        embeddedCheckoutPhase(first.status) === 'failure'
      )
        return;
      try {
        const nextAction = await client.getClientAction(binding.intentId, binding.clientSecret);
        if (disposed) return;
        if (!providerActionMatchesEnvironment(nextAction, binding.environment)) {
          setError(t(`${prefix}invalid`));
          return;
        }
        setAction(nextAction);
        const subscription = await client.subscribe(
          binding.intentId,
          binding.clientSecret,
          update,
          (state) => {
            if (state === 'live') void read();
          },
        );
        if (disposed) subscription.unsubscribe();
        else unsubscribe = subscription.unsubscribe;
      } catch {
        if (!disposed) setError(t(`${prefix}connection`));
      }
    })();
    const poll = setInterval(() => {
      void read();
    }, 3000);
    return () => {
      disposed = true;
      active.current = false;
      clearInterval(poll);
      unsubscribe?.();
    };
  }, [binding, client, t, feedback.play]);
  async function prepareCard() {
    if (inFlight.current || !prepareRef.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await prepareRef.current();
      if (!active.current) {
        if (result.prepared) result.authorization.dispose();
        return;
      }
      if (result.prepared) {
        authorizationRef.current?.dispose();
        authorizationRef.current = result.authorization;
        const { brand, last4 } = result.authorization.card;
        setPreparedCard({
          id: 'prepared-card',
          brand: brand.charAt(0).toUpperCase() + brand.slice(1),
          last4,
          saveForLater: false,
        });
        setStep('confirmation');
      } else setError(result.error);
    } catch {
      if (active.current) setError(t(`${prefix}connection`));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function confirm() {
    if (
      !binding ||
      inFlight.current ||
      !authorizationRef.current ||
      !action ||
      !providerActionMatchesEnvironment(action, binding.environment)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await authorizationRef.current.confirm();
      if (!active.current || terminal.current) return;
      if (result.accepted) {
        setAccepted(true);
        setStep((current) => (current === 'success' ? 'success' : 'processing'));
      } else setError(result.error);
    } catch {
      if (active.current && !terminal.current) setError(t(`${prefix}connection`));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  function close() {
    if (closed.current || inFlight.current || step === 'processing') return;
    closed.current = true;
    authorizationRef.current?.dispose();
    authorizationRef.current = null;
    feedback.stop();
    onClose();
  }
  if (!intent && !review) return null;
  const amount = intent ? Number(intent.amount) : (review?.amountMinorUnits ?? 0);
  const canAdvance = !!binding && !!intent && !!action;
  const cardAvailable =
    binding?.paymentMethods?.find((method) => method.id === 'card')?.available ??
    (!!binding && !binding.paymentMethods);
  const methodReason = (id: 'bank' | 'installments' | 'faircoin') => {
    const reason = binding?.paymentMethods?.find((method) => method.id === id)?.reason;
    const key =
      reason === 'subscription_method_not_configured'
        ? 'bankUnavailable'
        : reason === 'installment_offer_not_configured'
          ? 'installmentsUnavailable'
          : reason === 'merchant_receive_key_missing'
            ? 'faircoinUnavailable'
            : 'methodUnavailable';
    return t(`${prefix}${key}`);
  };
  return (
    <PeableCheckoutSheet
      open
      locale={i18n.language}
      interactionBlocked={busy}
      continueDisabled={!canAdvance}
      brandState={restoredBrand ? 'idle' : busy ? 'loading' : undefined}
      request={{
        merchant: binding?.subscription || review ? 'Mention' : t(`${prefix}title`),
        currency: intent?.currency ?? review?.currency ?? 'USD',
        dueTodayMinorUnits: amount,
        requiresContact: false,
        requiresShipping: false,
        // Only bound, implemented authorizations are selectable; unavailable Peable methods remain visible below.
        paymentMethods: canAdvance && cardAvailable ? ['card'] : [],
        tax: binding?.subscription?.tax,
        recurring: binding?.subscription
          ? {
              amountMinorUnits: binding.subscription.amountMinorUnits,
              interval: binding.subscription.interval,
              startsOn: binding.subscription.startsOn,
            }
          : review
            ? { amountMinorUnits: review.amountMinorUnits, interval: review.interval }
            : undefined,
        items: [
          {
            id: review?.offerId ?? intent?.id ?? 'review',
            name: binding?.subscription || review ? 'Mention Plus' : t(`${prefix}oneTime`),
            detail:
              binding?.subscription || review
                ? t(
                    `plus.payment.cadence${(binding?.subscription?.interval ?? review?.interval) === 'month' ? 'Month' : 'Year'}`,
                  )
                : t(`${prefix}noAccess`),
            quantity: 1,
            amountMinorUnits: amount,
          },
        ],
      }}
      draft={{ ...emptyCheckoutDraft(), card: preparedCard }}
      step={step}
      direction="forward"
      nextStep={preparedCard ? 'confirmation' : 'payment'}
      onDraft={() => {}}
      onStep={(next) => {
        if (canAdvance && !inFlight.current && !accepted) {
          if (next === 'card' || next === 'payment') {
            authorizationRef.current?.dispose();
            authorizationRef.current = null;
            setPreparedCard(null);
          }
          setStep(next);
        }
      }}
      onBack={() => {
        if (canAdvance && !inFlight.current && !accepted) {
          if (step === 'confirmation') {
            authorizationRef.current?.dispose();
            authorizationRef.current = null;
            setPreparedCard(null);
            setStep('card');
          } else setStep(step === 'card' ? 'payment' : 'review');
        }
      }}
      onClose={close}
      onAuthorize={() => {
        void confirm();
      }}
      onCard={() => {}}
      savedCards={[]}
      paymentMethods={
        binding
          ? [
              {
                id: 'bank',
                label: t('plus.checkout.rail.bank'),
                kind: 'account',
                detail: methodReason('bank'),
                disabled: true,
              },
              {
                id: 'installments',
                label: t('plus.checkout.installments.title'),
                kind: 'card',
                detail: methodReason('installments'),
                disabled: true,
              },
              {
                id: 'faircoin',
                label: 'FairCoin',
                kind: 'wallet',
                detail: methodReason('faircoin'),
                disabled: true,
              },
            ]
          : []
      }
      notice={
        onRetry ? (
          <Button onPress={onRetry}>{t('common.retry')}</Button>
        ) : error ? (
          <Text accessibilityRole="alert">{error}</Text>
        ) : undefined
      }
      cardEntry={
        action ? (
          <>
            <PeableProviderFields
              action={action}
              disabled={busy}
              locale={i18n.language}
              returnUrl={typeof window === 'undefined' ? '' : (window.location?.href ?? '')}
              onReady={(callback) => {
                prepareRef.current = callback;
                setReady(!!callback);
              }}
              onError={setError}
              loadingLabel={t(`${prefix}loading`)}
              unavailableLabel={t(`${prefix}connection`)}
            />
            <Button
              size="lg"
              disabled={!ready || busy}
              onPress={() => {
                void prepareCard();
              }}
            >
              {busy ? t(`${prefix}loading`) : t('plus.checkout.continue')}
            </Button>
          </>
        ) : undefined
      }
    />
  );
}
