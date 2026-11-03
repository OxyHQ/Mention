import { useCheckoutFeedback } from '@/hooks/useCheckoutFeedback';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { useSticker } from '@oxy.so/stickers/react';
import { EmptyStateSticker } from '@/components/common/EmptyStateSticker';
import { EMPTY_STATE_STICKERS } from '@/lib/stickers';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Image as ShapeImage } from '@oxy.so/bloom/shapes';
import { Text } from '@oxy.so/bloom/typography';
import { Dialog } from '@oxy.so/bloom/dialog';
import { useTranslation } from 'react-i18next';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import type { PlusCadence } from '@/lib/payments/plusCheckout';
import { emptyCheckoutDraft, nextCheckoutStep } from '@oxy.so/bloom/checkout-sheet/model';
import {
  PeableCheckoutSheet,
  type CheckoutCard,
  type CheckoutPaymentSelection,
  type PeableMethodDetails,
  type CheckoutDraft,
  type CheckoutRequest,
  type CheckoutStep,
} from '@peable.to/sdk/checkout/ui';
import type {
  CheckoutAuthorization,
  CheckoutPreviewCustomer,
  CheckoutScenario,
  PreviewOutcome,
} from '@/lib/payments/checkoutPreview';
import { LocalCheckoutCardEntry } from './LocalCheckoutCardEntry';

/** Local memory-only adapter. This file deliberately has no payment, storage or entitlement APIs. */
export function LocalCheckoutPreview({
  cadence,
  scenario,
  outcome,
  onClose,
  authorize,
  customer = { kind: 'guest' },
  soundEnabled = true,
  incomingFunds = false,
}: {
  cadence: PlusCadence;
  scenario: CheckoutScenario;
  outcome: PreviewOutcome;
  onClose(): void;
  customer?: CheckoutPreviewCustomer;
  soundEnabled?: boolean;
  incomingFunds?: boolean;
} & CheckoutAuthorization) {
  // Warm the shared catalogue cache while reviewing; completion never waits for artwork.
  useSticker(EMPTY_STATE_STICKERS.checkoutSuccess);
  useSticker(EMPTY_STATE_STICKERS.checkoutFailure);
  const { offer, loading, failed } = usePlusOffer(cadence);
  const [reviewedOffer, setReviewedOffer] = useState(offer);
  useEffect(() => {
    if (!reviewedOffer && offer) setReviewedOffer(offer);
  }, [offer, reviewedOffer]);
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<CheckoutStep>('review');
  const [demoBalance, setDemoBalance] = useState(25);
  const [activeMethod, setActiveMethod] = useState<string>('bank');
  const [faircoinView, setFaircoinView] = useState<'choices' | 'wallet' | 'external' | 'topup'>(
    'choices',
  );
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [draft, setDraft] = useState<CheckoutDraft>(() => ({
    ...emptyCheckoutDraft(),
    email: customer.email ?? '',
    paymentSelection: null,
  }));
  const [savedCards, setSavedCards] = useState<CheckoutCard[]>(() =>
    customer.simulated
      ? [
          { id: 'demo-linked-visa', brand: 'Visa', last4: '4242', saveForLater: true },
          { id: 'demo-linked-mastercard', brand: 'Mastercard', last4: '4444', saveForLater: true },
        ]
      : [],
  );
  const feedback = useCheckoutFeedback(soundEnabled);
  const attempt = useRef(0);
  const history = useRef<CheckoutStep[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fundingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(true);
  const closed = useRef(false);
  const completionTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [brandState, setBrandState] = useState<'idle' | undefined>();
  const close = useCallback(() => {
    if (closed.current || step === 'processing') return;
    closed.current = true;
    feedback.stop();
    completionTimers.current.forEach(clearTimeout);
    completionTimers.current = [];
    active.current = false;
    clearTimeout(timer.current);
    clearTimeout(fundingTimer.current);
    onClose();
  }, [onClose, feedback.stop, step]);
  useEffect(() => {
    if (step !== 'success') {
      setBrandState(undefined);
      return;
    }
    const restore = setTimeout(() => {
      if (active.current) setBrandState('idle');
    }, 1500);
    const dismiss = setTimeout(() => {
      if (active.current) close();
    }, 1800);
    completionTimers.current = [restore, dismiss];
    return () => {
      completionTimers.current = [];
      clearTimeout(restore);
      clearTimeout(dismiss);
    };
  }, [step, close]);
  const authorizing = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (
      !incomingFunds ||
      !customer.simulated ||
      step !== 'method' ||
      faircoinView !== 'topup' ||
      demoBalance !== 25
    )
      return;
    const arrival = setTimeout(() => {
      if (active.current) setDemoBalance(150);
    }, 2000);
    fundingTimer.current = arrival;
    return () => clearTimeout(arrival);
  }, [incomingFunds, customer.simulated, step, faircoinView, demoBalance]);
  const displayOffer =
    scenario === 'trial'
      ? {
          displayName: t('plus.checkout.demoTrialItem'),
          price: { currency: 'USD', amountMinorUnits: 599 },
        }
      : reviewedOffer;
  if (!displayOffer?.price && scenario !== 'physical')
    return (
      <Dialog open onClose={close} placement="bottom" detached panelStyle={{ maxWidth: 540 }}>
        <View style={{ padding: 20, gap: 16 }}>
          <Text>
            {t(
              loading ? 'common.loading' : failed ? 'plus.payment.failed' : 'plus.payment.notReady',
            )}
          </Text>
        </View>
      </Dialog>
    );
  const price = displayOffer?.price;

  const request: CheckoutRequest =
    scenario === 'physical'
      ? {
          merchant: t('plus.checkout.demoMerchant'),
          currency: 'USD',
          dueTodayMinorUnits: draft.paymentSelection?.method === 'installments' ? 700 : 2800,
          totalMinorUnits: draft.paymentSelection?.method === 'installments' ? 2800 : undefined,
          items: [
            {
              id: 'demo-item',
              artwork: (
                <ShapeImage
                  shape="squircle"
                  size={40}
                  source={require('../../assets/images/mention-icon.png')}
                  alt="Mention sticker pack"
                />
              ),
              name: t('plus.checkout.demoItem'),
              detail: t('plus.checkout.demoItemDetail'),
              quantity: 1,
              amountMinorUnits: 2800,
            },
          ],
          requiresContact: customer.kind === 'guest',
          requiresShipping: true,
          paymentMethods: ['card', 'bank', 'faircoin', 'installments'],
          taxDescription: t('plus.checkout.included'),
        }
      : {
          merchant: scenario === 'trial' ? t('plus.checkout.demoTrialMerchant') : 'Mention',
          currency: price?.currency ?? 'USD',
          dueTodayMinorUnits: scenario === 'trial' ? 0 : (price?.amountMinorUnits ?? 0),
          items: [
            {
              id: 'subscription',
              name:
                scenario === 'trial'
                  ? t('plus.checkout.demoTrialItem')
                  : (displayOffer?.displayName ?? ''),
              detail:
                scenario === 'trial'
                  ? t('plus.checkout.trialDetail')
                  : t(`plus.payment.cadence${cadence === 'year' ? 'Year' : 'Month'}`),
              artwork:
                scenario === 'subscription' ? (
                  <ShapeImage
                    shape="squircle"
                    size={40}
                    alt={displayOffer?.displayName ?? 'Mention'}
                    source={require('../../assets/images/mention-icon.png')}
                  />
                ) : undefined,
              quantity: 1,
              amountMinorUnits: scenario === 'trial' ? 0 : (price?.amountMinorUnits ?? 0),
            },
          ],
          requiresContact: customer.kind === 'guest',
          requiresShipping: false,
          paymentMethods: ['card', 'bank', 'faircoin'],
          taxDescription: t('plus.checkout.included'),
          recurring: {
            amountMinorUnits: price?.amountMinorUnits ?? 0,
            interval: scenario === 'trial' ? 'month' : cadence,
            startsOn:
              scenario === 'trial'
                ? new Date(Date.now() + 7 * 86400000).toLocaleDateString()
                : new Date().toLocaleDateString(),
            renewalTerms: scenario === 'trial' ? t('plus.checkout.demoRenewal') : undefined,
            cancellationTerms:
              scenario === 'trial' ? t('plus.checkout.demoCancellation') : undefined,
          },
        };
  function navigate(next: CheckoutStep) {
    if (next === step || step === 'processing') return;
    clearTimeout(timer.current);
    setDirection(next === 'review' ? 'backward' : 'forward');
    if (next === 'review') history.current = [];
    else history.current.push(step);
    setStep(next);
  }
  function back() {
    if (step === 'processing') return;
    if (step === 'method' && activeMethod === 'faircoin' && faircoinView !== 'choices') {
      setDirection('backward');
      setFaircoinView(faircoinView === 'topup' ? 'wallet' : 'choices');
      return;
    }
    clearTimeout(timer.current);
    setDirection('backward');
    setStep(history.current.pop() ?? 'review');
  }
  async function simulateAuthorization() {
    if (authorizing.current || nextCheckoutStep(request, draft) !== 'review') return;
    authorizing.current = true;
    attempt.current += 1;
    setDirection('forward');
    setStep('processing');
    try {
      if (authorize && (await authorize()) !== 'authorized') {
        if (active.current) setStep('review');
        authorizing.current = false;
        return;
      }
      if (!active.current) return;
      const result = outcome === 'failure' ? 'failure' : 'success';
      timer.current = setTimeout(
        () => {
          if (active.current) {
            setStep(result);
            feedback.play(result, attempt.current);
          }
          authorizing.current = false;
        },
        outcome === 'loading' ? 8000 : 1000,
      );
    } catch {
      if (active.current) {
        setStep('failure');
        feedback.play('failure', attempt.current);
      }
      authorizing.current = false;
    }
  }
  function chooseCard(card: CheckoutCard) {
    setDraft((current) => ({
      ...current,
      card,
      paymentSelection: { id: card.id, method: 'card', label: `${card.brand} ···· ${card.last4}` },
    }));
    setSavedCards((current) =>
      card.saveForLater
        ? [...current.filter((item) => item.id !== card.id), card]
        : current.filter((item) => item.id !== card.id),
    );
  }
  function chooseMethod(selection: CheckoutPaymentSelection) {
    setDraft((current) => ({ ...current, paymentSelection: selection }));
    navigate('review');
  }
  // Explicit tender fixtures for these scenarios, never a display-currency FX conversion.
  const faircoinAmount =
    scenario === 'trial' ? 0 : scenario === 'physical' ? 56 : cadence === 'year' ? 115 : 12;
  const methodDetails: PeableMethodDetails =
    activeMethod === 'installments'
      ? {
          kind: 'installments',
          dueTodayLabel: '$7.00',
          totalLabel: '$28.00',
          feesLabel: '$0.00',
          schedule: [
            { id: 'today', label: t('plus.checkout.installments.today'), amountLabel: '$7.00' },
            { id: 'two', label: t('plus.checkout.installments.two'), amountLabel: '$7.00' },
            { id: 'four', label: t('plus.checkout.installments.four'), amountLabel: '$7.00' },
            { id: 'six', label: t('plus.checkout.installments.six'), amountLabel: '$7.00' },
          ],
          disclosure: t('plus.checkout.installments.preview'),
          onSelect: () =>
            chooseMethod({
              id: 'installments',
              method: 'installments',
              label: t('plus.checkout.installments.title'),
              detail: t('plus.checkout.installments.summary'),
            }),
        }
      : activeMethod === 'faircoin'
        ? {
            kind: 'faircoin',
            amountLabel: `${faircoinAmount} FAIR`,
            quoteDescription: t('plus.checkout.rail.demoQuote'),
            view: faircoinView,
            wallet: customer.simulated
              ? {
                  balanceLabel: `${demoBalance} FAIR`,
                  remainingLabel:
                    demoBalance >= faircoinAmount ? `${demoBalance - faircoinAmount} FAIR` : '—',
                  amountNeededLabel:
                    demoBalance < faircoinAmount
                      ? `${faircoinAmount - demoBalance} FAIR`
                      : undefined,
                  canPay: demoBalance >= faircoinAmount,
                  onOpen: () => setFaircoinView('wallet'),
                  topUp: {
                    payload: 'PEABLE_LOCAL_WALLET_TOPUP_PREVIEW_NOT_PAYABLE',
                    addressLabel: t('plus.checkout.rail.topupPreview'),
                    onOpen: () => setFaircoinView('topup'),
                  },
                  onSelect: () => {
                    if (demoBalance < faircoinAmount) return;
                    chooseMethod({
                      id: 'faircoin-wallet',
                      method: 'faircoin',
                      label: t('plus.checkout.rail.wallet'),
                      detail: t('plus.checkout.rail.demoQuote'),
                    });
                  },
                }
              : undefined,
            external: {
              payload: 'PEABLE_LOCAL_PREVIEW_NOT_A_PAYMENT',
              addressLabel: t('plus.checkout.rail.nonpayable'),
              onOpen: () => setFaircoinView('external'),
              onSelect: () =>
                chooseMethod({
                  id: 'faircoin-external',
                  method: 'faircoin',
                  label: t('plus.checkout.rail.external'),
                  detail: t('plus.checkout.rail.nonpayable'),
                }),
            },
          }
        : {
            kind: 'provider',
            title: t(
              activeMethod === 'bank' ? 'plus.checkout.rail.bank' : 'plus.checkout.rail.other',
            ),
            description: t('plus.checkout.rail.providerPreview'),
            actionLabel: t('plus.checkout.continue'),
            onContinue: () =>
              chooseMethod({
                id: activeMethod,
                method: activeMethod,
                label: t(
                  activeMethod === 'bank' ? 'plus.checkout.rail.bank' : 'plus.checkout.rail.other',
                ),
                detail:
                  activeMethod === 'bank' ? '···· 6789' : t('plus.checkout.rail.providerPreview'),
              }),
          };
  return (
    <PeableCheckoutSheet
      open
      locale={i18n.language}
      brandState={brandState}
      accountSummary={
        customer.kind === 'account'
          ? {
              name: customer.displayName || t('plus.checkout.customer.accountLabel'),
              detail: customer.simulated
                ? customer.email
                : t('plus.checkout.customer.accountLabel'),
              avatar: (
                <AccountAvatar
                  account={{ name: customer.displayName, avatar: customer.avatar }}
                  size="lg"
                />
              ),
            }
          : undefined
      }
      resultIllustration={
        step === 'success' ? (
          <EmptyStateSticker name="checkoutSuccess" />
        ) : step === 'failure' ? (
          <EmptyStateSticker name="checkoutFailure" />
        ) : undefined
      }
      request={request}
      paymentMethods={[
        {
          id: 'bank',
          label: t('plus.checkout.rail.bank'),
          detail: customer.simulated ? t('plus.checkout.rail.demoBank') : undefined,
          kind: 'account',
        },
        {
          id: 'faircoin',
          label: 'FairCoin',
          detail: t('plus.checkout.rail.faircoin'),
          kind: 'wallet',
        },
        { id: 'installments', label: t('plus.checkout.installments.title'), kind: 'account' },
      ]}
      onMethod={(method) => {
        setActiveMethod(method);
        setFaircoinView('choices');
        navigate('method');
      }}
      methodDetails={methodDetails}
      draft={draft}
      step={step}
      frameKey={step === 'method' ? `${activeMethod}:${faircoinView}` : step}
      direction={direction}
      onDraft={setDraft}
      onStep={navigate}
      onBack={back}
      onClose={close}
      onAuthorize={() => {
        void simulateAuthorization();
      }}
      savedCards={savedCards}
      onCard={chooseCard}
      messages={Object.fromEntries(
        [
          'result.processing',
          'result.success',
          'result.failure',
          'result.processingHint',
          'result.successHint',
          'result.failureHint',
          'savedCard',
          'contactHint',
          'delivery.standardHint',
          'delivery.expressHint',
        ].map((key) => [key, t(`plus.checkout.${key}`)]),
      )}
      cardEntry={
        step === 'card' ? (
          <LocalCheckoutCardEntry
            card={draft.card}
            onCard={chooseCard}
            onDone={() => navigate('review')}
          />
        ) : undefined
      }
    />
  );
}
