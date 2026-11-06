import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { emptyCheckoutDraft } from '@oxy.so/bloom/checkout-sheet/model';
import { createPeableCheckout } from '@peable.to/sdk/checkout';
import {
  PeableCheckoutSheet,
  type CheckoutStep,
  type PeableMethodDetails,
} from '@peable.to/sdk/checkout/ui';
import { useTranslation } from 'react-i18next';
import { plusPriceMajorUnits, type PlusOffer } from '@/lib/payments/plusCheckout';
import {
  faircoinAvailability,
  faircoinInFlight,
  faircoinPayment,
  faircoinRefusalReason,
  faircoinTransferState,
  faircoinUnavailableKey,
  formatFairAmount,
  sessionMatchesOffer,
  type FaircoinPayment,
  type PlusCheckoutSession,
  type PlusSessionCapability,
} from '@/lib/payments/plusSessionCheckout';

const POLL_MS = 3000;
const TRANSFER_STATES = [
  'awaiting',
  'detected',
  'processing',
  'succeeded',
  'failure',
  'expired',
] as const;
/** Sheet copy Mention already translates in every locale it ships. */
const SHARED_SHEET_KEYS = [
  'payMerchant',
  'dueToday',
  'quantity',
  'recurring',
  'month',
  'year',
  'continue',
  'addPayment',
  'section.payment',
  'step.payment',
  'subtotal',
  'tax',
  'done',
] as const;

/** Opens the hosted page from the press that asked for it; `before` runs first and may veto it. */
export type OpenHostedCheckout = (url: string, before?: () => Promise<boolean>) => Promise<void>;

/** Only a phone can plausibly hold the Peable app that answers a `peable://` request. */
function canOpenPeableHere(): boolean {
  if (Platform.OS !== 'web') return true;
  return (
    typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent ?? '')
  );
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Mention Plus's Peable order in Mention's own sheet: the card (on Peable's
 * hosted page) and FairCoin, which is always listed (Peable ADR 0021) — disabled
 * with its reason when it cannot be paid. Every state comes from the gateway's
 * session; completion is the session's, and access stays Oxy's to confirm.
 */
export function PlusSessionCheckout({
  capability,
  hostedUrl,
  offer,
  openHosted,
  onSettled,
  onUnavailable,
  onClose,
}: {
  capability: PlusSessionCapability;
  hostedUrl: string;
  offer: PlusOffer;
  openHosted: OpenHostedCheckout;
  /** The gateway closed the order (complete or expired); the host asks Oxy for the outcome. */
  onSettled(): void;
  /** The session cannot be read or is not the reviewed order; the host falls back to the hosted page. */
  onUnavailable(): void;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const client = useMemo(() => createPeableCheckout(), []);
  const [session, setSession] = useState<PlusCheckoutSession | null>(null);
  const [step, setStep] = useState<CheckoutStep>('review');
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<FaircoinPayment | null>(null);
  const [now, setNow] = useState(nowSeconds);
  const inFlight = useRef(false);
  const settled = useRef(false);
  const active = useRef(true);
  const callbacks = useRef({ onSettled, onUnavailable });
  useEffect(() => {
    callbacks.current = { onSettled, onUnavailable };
  });
  const amountMinorUnits = offer.price?.amountMinorUnits ?? -1;
  const currency = offer.price?.currency ?? '';

  const accept = useCallback(
    (value: PlusCheckoutSession) => {
      if (!active.current) return;
      if (!sessionMatchesOffer(value, capability, { amountMinorUnits, currency })) {
        callbacks.current.onUnavailable();
        return;
      }
      setSession(value);
      setNow(nowSeconds());
      const payment = faircoinPayment(value.payment_intent);
      if (payment) setTracked(payment);
      if ((value.status === 'complete' || value.status === 'expired') && !settled.current) {
        settled.current = true;
        callbacks.current.onSettled();
      }
    },
    [capability, amountMinorUnits, currency],
  );
  const refresh = useCallback(
    async () =>
      accept(await client.getCheckoutSession(capability.sessionId, capability.clientSecret)),
    [accept, client, capability],
  );

  useEffect(() => {
    active.current = true;
    let loaded = false;
    let gaveUp = false;
    const read = () => {
      refresh()
        .then(() => {
          loaded = true;
        })
        .catch(() => {
          // A session that cannot be read at all (an origin the gateway does not
          // admit, say) goes back to the hosted page; a later read keeps the last answer.
          if (loaded || gaveUp || !active.current) return;
          gaveUp = true;
          callbacks.current.onUnavailable();
        });
    };
    read();
    const poll = setInterval(read, POLL_MS);
    return () => {
      active.current = false;
      clearInterval(poll);
    };
  }, [refresh]);

  const go = (next: CheckoutStep, way: 'forward' | 'backward' = 'forward') => {
    setDirection(way);
    setStep(next);
  };

  async function chooseFaircoin() {
    if (!session || inFlight.current) return;
    const live = faircoinPayment(session.payment_intent);
    if (live && faircoinTransferState(live.intent, nowSeconds()) !== 'expired') {
      go('method');
      return;
    }
    if (!faircoinAvailability(session).available) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setTracked(null);
    go('method');
    try {
      const next = await client.confirmCheckoutSession(
        capability.sessionId,
        capability.clientSecret,
        { payment_method_type: 'faircoin' },
      );
      accept(next);
      if (active.current && !faircoinPayment(next.payment_intent))
        setError(t('plus.checkout.faircoin.failed'));
    } catch (failure) {
      if (!active.current) return;
      // Shown on the FairCoin step itself; the list behind it re-reads availability.
      const reason = faircoinRefusalReason(failure);
      setError(t(reason ? faircoinUnavailableKey(reason) : 'plus.checkout.faircoin.failed'));
      void refresh().catch(() => undefined);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  function payByCard() {
    if (!session || inFlight.current) return;
    const current = session.payment_intent;
    if (faircoinInFlight(current)) {
      setError(t('plus.checkout.faircoin.confirming'));
      return;
    }
    // The hosted page resumes the session's own payment: replace an unpaid
    // FairCoin one first, so it opens on the card.
    const switchToCard = current?.rail === 'faircoin' && current.status === 'requires_action';
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void openHosted(
      hostedUrl,
      switchToCard
        ? async () => {
            try {
              const next = await client.confirmCheckoutSession(
                capability.sessionId,
                capability.clientSecret,
                { payment_method_type: 'card' },
              );
              accept(next);
              return next.payment_intent?.rail === 'card';
            } catch {
              if (active.current) setError(t('plus.checkout.card.failed'));
              return false;
            }
          }
        : undefined,
    ).finally(() => {
      inFlight.current = false;
      if (active.current) {
        setBusy(false);
        void refresh().catch(() => undefined);
      }
    });
  }

  function openPeable(deepLink: string) {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.location.href = deepLink;
      return;
    }
    Linking.openURL(deepLink).catch(() => setError(t('plus.checkout.faircoin.noPeable')));
  }

  const messages = useMemo(
    () => ({
      ...Object.fromEntries(SHARED_SHEET_KEYS.map((key) => [key, t(`plus.checkout.${key}`)])),
      paymentHint: t('plus.checkout.choosePayment'),
      addCard: t('plus.checkout.card.generic'),
      'step.card': t('plus.checkout.card.generic'),
      'faircoin.externalHint': t('plus.checkout.faircoin.hint'),
      'faircoin.qr': t('plus.checkout.faircoin.qr'),
      ...Object.fromEntries(
        TRANSFER_STATES.map((state) => [
          `faircoin.transfer.${state}`,
          t(`plus.checkout.faircoin.transfer.${state}`),
        ]),
      ),
    }),
    [t],
  );

  if (!session || !offer.price) return null;
  const availability = faircoinAvailability(session);
  const reasonText = availability.available
    ? t('plus.checkout.faircoin.available')
    : t(faircoinUnavailableKey(availability.reason));
  const amount = Number(session.amount_total);
  const sessionCurrency = session.currency.toUpperCase();
  const selectable = [
    ...(session.payment_method_types.includes('card') ? ['card'] : []),
    ...(availability.available ? ['faircoin'] : []),
  ];
  const methodDetails = step === 'method' && tracked ? faircoinDetails(tracked) : undefined;

  function faircoinDetails(payment: FaircoinPayment): PeableMethodDetails {
    const current =
      session?.payment_intent?.id === payment.intent.id ? session.payment_intent : null;
    const state = current ? faircoinTransferState(current, now) : 'expired';
    const expired = state === 'expired';
    const quote = payment.quote;
    const quoteDescription = expired
      ? t('plus.checkout.faircoin.expired')
      : quote
        ? `${t('plus.checkout.faircoin.quote', {
            amount: new Intl.NumberFormat(i18n.language, {
              style: 'currency',
              currency: quote.currency,
            }).format(
              plusPriceMajorUnits({
                currency: quote.currency,
                amountMinorUnits: Number(quote.amount),
              }),
            ),
            rate: quote.rate,
            currency: quote.currency,
          })} ${t('plus.checkout.faircoin.holdsUntil', {
            time: new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(
              new Date(quote.expires_at * 1000),
            ),
          })}`
        : '';
    return {
      kind: 'faircoin',
      amountLabel: formatFairAmount(payment.amount),
      quoteDescription,
      view: 'external',
      external: {
        // On a phone the request opens Peable directly (Continue); elsewhere the
        // QR carries the same request to Peable on the payer's phone.
        state: state === 'awaiting' && canOpenPeableHere() ? undefined : state,
        payload: expired ? '' : payment.deepLink,
        addressLabel: expired ? '' : t('plus.checkout.faircoin.peableOnly'),
        onOpen: () => openPeable(payment.deepLink),
        onSelect: () => openPeable(payment.deepLink),
      },
    };
  }

  return (
    <PeableCheckoutSheet
      open
      locale={i18n.language}
      messages={messages}
      interactionBlocked={busy}
      request={{
        merchant: 'Mention',
        currency: sessionCurrency,
        dueTodayMinorUnits: amount,
        requiresContact: false,
        requiresShipping: false,
        paymentMethods: selectable,
        recurring: { amountMinorUnits: amount, interval: offer.price.interval },
        items: [
          {
            id: offer.offerId,
            name: 'Mention Plus',
            detail: t(`plus.payment.cadence${offer.price.interval === 'year' ? 'Year' : 'Month'}`),
            quantity: 1,
            amountMinorUnits: amount,
          },
        ],
      }}
      paymentMethods={[
        {
          id: 'faircoin',
          label: 'FairCoin',
          kind: 'wallet',
          detail: reasonText,
          disabled: !availability.available,
        },
      ]}
      draft={emptyCheckoutDraft()}
      step={step}
      direction={direction}
      frameKey={
        methodDetails?.kind === 'faircoin'
          ? methodDetails.external?.state
          : error
            ? 'error'
            : undefined
      }
      methodTitle={t('plus.checkout.faircoin.title')}
      methodContent={
        error ? (
          <>
            <Text accessibilityRole="alert">{error}</Text>
            <Button
              size="lg"
              onPress={() => {
                setError(null);
                go('payment', 'backward');
              }}
            >
              {t('plus.checkout.faircoin.otherMethod')}
            </Button>
          </>
        ) : (
          <ActivityIndicator accessibilityLabel={t('common.loading')} />
        )
      }
      methodDetails={methodDetails}
      onMethod={(id) => {
        if (id === 'faircoin') void chooseFaircoin();
      }}
      onDraft={() => {}}
      onStep={(next) => {
        if (!inFlight.current) go(next);
      }}
      onBack={() => {
        if (inFlight.current) return;
        setError(null);
        go(step === 'method' || step === 'card' ? 'payment' : 'review', 'backward');
      }}
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
      onAuthorize={() => {}}
      onCard={() => {}}
      savedCards={[]}
      notice={error ? <Text accessibilityRole="alert">{error}</Text> : undefined}
      cardEntry={
        <>
          <Text>{t('plus.checkout.card.hint')}</Text>
          {error && <Text accessibilityRole="alert">{error}</Text>}
          <Button size="lg" disabled={busy} onPress={payByCard}>
            {t('plus.checkout.card.open')}
          </Button>
        </>
      }
    />
  );
}
