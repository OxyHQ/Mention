import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { Dialog } from '@oxy.so/bloom/dialog';
import { createPeableCheckout, type PeableClientAction } from '@peable.to/sdk/checkout';
import {
  PeableCheckoutSheet,
  PeableProviderFields,
  type ProviderConfirmation,
  type CheckoutStep,
} from '@peable.to/sdk/checkout/ui';
import { emptyCheckoutDraft } from '@oxy.so/bloom/checkout-sheet/model';
import { useTranslation } from 'react-i18next';
import { useCheckoutFeedback } from '@/hooks/useCheckoutFeedback';
import {
  isTestProviderAction,
  localProviderPhase,
  type LocalProviderTestBinding,
} from '@/lib/payments/localProviderTest';

type Intent = Awaited<ReturnType<ReturnType<typeof createPeableCheckout>['getPaymentIntent']>>;
/** Local TEST gateway only. Success comes exclusively from the gateway's verified provider events. */
export function LocalProviderTestSheet({
  binding,
  onClose,
}: {
  binding: LocalProviderTestBinding;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const client = useMemo(
    () => createPeableCheckout({ gatewayUrl: binding.apiUrl }),
    [binding.apiUrl],
  );
  const [intent, setIntent] = useState<Intent | null>(null);
  const [action, setAction] = useState<PeableClientAction | null>(null);
  const [step, setStep] = useState<CheckoutStep>('review');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [retry, setRetry] = useState(0);
  const active = useRef(true);
  const inFlight = useRef(false);
  const terminal = useRef<'success' | 'failure' | null>(null);
  const confirmRef = useRef<(() => Promise<ProviderConfirmation>) | null>(null);
  const feedback = useCheckoutFeedback(true);
  const sounded = useRef(false);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reconnects the same payer capability after a load error.
  useEffect(() => {
    active.current = true;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const update = (value: Intent) => {
      if (disposed || value.id !== binding.intentId) return;
      if (
        value.rail !== 'card' ||
        value.currency !== 'USD' ||
        !/^\d+$/.test(value.amount) ||
        !Number.isSafeInteger(Number(value.amount)) ||
        Number(value.amount) <= 0
      ) {
        setError(t(`${prefix}invalid`));
        return;
      }
      if (terminal.current) return;
      setIntent(value);
      setError(null);
      const phase = localProviderPhase(value.status);
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
      else if (value.status === 'failed') {
        setAccepted(false);
        setStep('card');
        setError(t(`${prefix}declined`));
      }
    };
    const read = async () => {
      try {
        const value = await client.getPaymentIntent(binding.intentId, binding.clientSecret);
        update(value);
        return value;
      } catch {
        if (!disposed) setError(t(`${prefix}connection`));
        return null;
      }
    };
    void (async () => {
      const first = await read();
      if (
        disposed ||
        !first ||
        first.rail !== 'card' ||
        localProviderPhase(first.status) === 'success' ||
        localProviderPhase(first.status) === 'failure'
      )
        return;
      try {
        const nextAction = await client.getClientAction(binding.intentId, binding.clientSecret);
        if (disposed) return;
        if (!isTestProviderAction(nextAction)) {
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
  }, [binding.intentId, binding.clientSecret, client, retry, t, feedback.play]);
  async function confirm() {
    if (
      inFlight.current ||
      !confirmRef.current ||
      !ready ||
      !action ||
      !isTestProviderAction(action)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await confirmRef.current();
    if (!active.current) return;
    inFlight.current = false;
    setBusy(false);
    if (terminal.current) return;
    if (result.accepted) {
      setAccepted(true);
      setStep((current) => (current === 'success' ? 'success' : 'processing'));
    } else setError(result.error);
  }
  function close() {
    if (closed.current || inFlight.current || step === 'processing') return;
    closed.current = true;
    feedback.stop();
    onClose();
  }
  if (!intent || (!action && !['success', 'failure', 'processing'].includes(step)))
    return (
      <Dialog
        open
        placement="bottom"
        detached
        onClose={close}
        header={{ title: t(`${prefix}title`), showClose: true }}
      >
        <View style={{ gap: 16, padding: 20 }}>
          <Text>{error ?? t(`${prefix}loading`)}</Text>
          {error && (
            <Button
              onPress={() => {
                setError(null);
                setRetry((value) => value + 1);
              }}
            >
              {t('common.retry')}
            </Button>
          )}
        </View>
      </Dialog>
    );
  const amount = Number(intent.amount);
  const amountLabel = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: intent.currency,
  }).format(amount / 100);
  return (
    <PeableCheckoutSheet
      open
      locale={i18n.language}
      interactionBlocked={busy}
      brandState={restoredBrand ? 'idle' : busy ? 'loading' : undefined}
      request={{
        merchant: t(`${prefix}title`),
        currency: intent.currency,
        dueTodayMinorUnits: amount,
        requiresContact: false,
        requiresShipping: false,
        paymentMethods: ['card'],
        items: [
          {
            id: intent.id,
            name: t(`${prefix}oneTime`),
            detail: t(`${prefix}noAccess`),
            quantity: 1,
            amountMinorUnits: amount,
          },
        ],
      }}
      draft={emptyCheckoutDraft()}
      step={step}
      direction="forward"
      messages={{ 'step.card': t(`${prefix}paymentDetails`) }}
      nextStep="card"
      onDraft={() => {}}
      onStep={(next) => {
        if (!inFlight.current && !accepted) setStep(next);
      }}
      onBack={() => {
        if (!inFlight.current && !accepted) setStep('review');
      }}
      onClose={close}
      onAuthorize={() => {
        void confirm();
      }}
      onCard={() => {}}
      savedCards={[]}
      notice={error ? <Text accessibilityRole="alert">{error}</Text> : undefined}
      cardEntry={
        action ? (
          <>
            <PeableProviderFields
              action={action}
              locale={i18n.language}
              returnUrl={typeof window === 'undefined' ? '' : (window.location?.href ?? '')}
              onReady={(callback) => {
                confirmRef.current = callback;
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
                void confirm();
              }}
            >
              {busy ? t(`${prefix}confirming`) : t(`${prefix}pay`, { amount: amountLabel })}
            </Button>
          </>
        ) : undefined
      }
    />
  );
}
