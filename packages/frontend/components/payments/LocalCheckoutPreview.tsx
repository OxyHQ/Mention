import { LocalOrderPreview } from './LocalOrderPreview';
import * as Clipboard from 'expo-clipboard';
import {
  DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES,
  eligibleInstallmentPlans,
  previewInstallmentSchedule,
  type MerchantInstallmentPreferences,
} from '@/lib/payments/merchantInstallmentPreview';
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
  merchantInstallmentPreferences = DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES,
  previewInstallmentDecision = 'available',
}: {
  cadence: PlusCadence;
  scenario: CheckoutScenario;
  outcome: PreviewOutcome;
  onClose(): void;
  customer?: CheckoutPreviewCustomer;
  soundEnabled?: boolean;
  incomingFunds?: boolean;
  merchantInstallmentPreferences?: MerchantInstallmentPreferences;
  previewInstallmentDecision?: 'available' | 'pending' | 'rejected' | 'unavailable';
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
  const [externalTransfer, setExternalTransfer] = useState<{
    phase: 'awaiting' | 'detected' | 'processing' | 'succeeded' | 'failure';
    amountLabel: string;
    payload: string;
  } | null>(null);
  const [installmentTermsOpen, setInstallmentTermsOpen] = useState(false);
  const [selectedInstallmentId, setSelectedInstallmentId] = useState('pay_in_4');
  const eligiblePlans = eligibleInstallmentPlans(merchantInstallmentPreferences, {
    currency: scenario === 'physical' ? 'USD' : (reviewedOffer?.price.currency ?? 'USD'),
    country: 'US',
    amountMinorUnits:
      scenario === 'physical'
        ? 2800
        : scenario === 'trial'
          ? 0
          : (reviewedOffer?.price.amountMinorUnits ?? 0),
    purchaseKind: scenario === 'physical' ? 'one_time' : 'subscription',
  });
  const selectedInstallment =
    eligiblePlans.find((plan) => plan.id === selectedInstallmentId) ?? eligiblePlans[0];
  const installmentQuote = selectedInstallment
    ? previewInstallmentSchedule(2800, selectedInstallment)
    : null;
  const installmentBinding = JSON.stringify({
    scenario,
    merchantInstallmentPreferences,
    amountMinorUnits: scenario === 'physical' ? 2800 : reviewedOffer?.price.amountMinorUnits,
    currency: reviewedOffer?.price.currency,
    previewInstallmentDecision,
  });

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
  const externalPending = useRef(false);
  const pendingDraft = useRef(draft);
  pendingDraft.current = draft;
  const [savedCards, setSavedCards] = useState<CheckoutCard[]>(() =>
    customer.simulated
      ? [
          { id: 'demo-linked-visa', brand: 'Visa', last4: '4242', saveForLater: true },
          { id: 'demo-linked-mastercard', brand: 'Mastercard', last4: '4444', saveForLater: true },
        ]
      : [],
  );
  const feedback = useCheckoutFeedback(soundEnabled);
  const previousInstallmentBinding = useRef(installmentBinding);
  useEffect(() => {
    if (previousInstallmentBinding.current === installmentBinding) return;
    previousInstallmentBinding.current = installmentBinding;
    setDraft((current) =>
      current.paymentSelection?.method === 'installments'
        ? { ...current, paymentSelection: null }
        : current,
    );
  }, [installmentBinding]);
  const attempt = useRef(0);
  const history = useRef<CheckoutStep[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fundingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(true);
  const closed = useRef(false);
  const completionTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [brandState, setBrandState] = useState<'idle' | undefined>();
  const [showOrder, setShowOrder] = useState(false);
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
      if (active.current) {
        if (scenario === 'physical') setShowOrder(true);
        else close();
      }
    }, 1800);
    completionTimers.current = [restore, dismiss];
    return () => {
      completionTimers.current = [];
      clearTimeout(restore);
      clearTimeout(dismiss);
    };
  }, [step, close, scenario]);
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
  useEffect(() => {
    if (
      !externalTransfer ||
      externalTransfer.phase === 'succeeded' ||
      externalTransfer.phase === 'failure'
    )
      return;
    if (externalTransfer.phase === 'awaiting' && !incomingFunds) return;
    const phase = externalTransfer.phase;
    const pending = setTimeout(
      () => {
        if (!active.current) return;
        if (phase === 'awaiting') {
          authorizing.current = true;
          attempt.current += 1;
          setExternalTransfer((current) => current && { ...current, phase: 'detected' });
          setStep('processing');
        } else if (phase === 'detected') {
          setExternalTransfer((current) => current && { ...current, phase: 'processing' });
        } else {
          const result = outcome === 'failure' ? 'failure' : 'success';
          setExternalTransfer(
            (current) =>
              current && { ...current, phase: result === 'success' ? 'succeeded' : 'failure' },
          );
          authorizing.current = false;
          setStep(result);
          feedback.play(result, attempt.current);
        }
      },
      phase === 'awaiting' ? 2000 : 1000,
    );
    return () => clearTimeout(pending);
  }, [externalTransfer, incomingFunds, outcome, feedback.play]);
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
          dueTodayMinorUnits:
            draft.paymentSelection?.method === 'installments' && installmentQuote
              ? installmentQuote.dueTodayMinorUnits
              : 2800,
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
          paymentMethods: [
            'card',
            'bank',
            'faircoin',
            ...(eligiblePlans.length ? ['installments'] : []),
          ],
          tax: {
            subtotalMinorUnits: 2600,
            taxMinorUnits: 200,
            totalMinorUnits: 2800,
            inclusive: true,
          },
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
          tax:
            scenario === 'trial'
              ? { subtotalMinorUnits: 0, taxMinorUnits: 0, totalMinorUnits: 0, inclusive: true }
              : price?.currency === 'USD' && price.amountMinorUnits === 599
                ? {
                    subtotalMinorUnits: 557,
                    taxMinorUnits: 42,
                    totalMinorUnits: 599,
                    inclusive: true,
                  }
                : price?.currency === 'USD' && price.amountMinorUnits === 5750
                  ? {
                      subtotalMinorUnits: 5350,
                      taxMinorUnits: 400,
                      totalMinorUnits: 5750,
                      inclusive: true,
                    }
                  : undefined,
          taxDescription: t('plus.checkout.taxPending'),
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
    if (step === 'method' && activeMethod === 'installments' && installmentTermsOpen) {
      setInstallmentTermsOpen(false);
      setDirection('backward');
      return;
    }
    if (step === 'method' && activeMethod === 'faircoin' && faircoinView !== 'choices') {
      setDirection('backward');
      if (faircoinView === 'external') {
        setExternalTransfer(null);
        externalPending.current = false;
        setDraft((current) =>
          current.paymentSelection?.id === 'faircoin-external'
            ? { ...current, paymentSelection: null }
            : current,
        );
      }
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
  function continueWithDraft(nextDraft: CheckoutDraft) {
    setDraft(nextDraft);
    pendingDraft.current = nextDraft;
    const next = nextCheckoutStep(request, nextDraft);
    if (next === 'review' && externalPending.current) {
      externalPending.current = false;
      setExternalTransfer({
        phase: 'awaiting',
        amountLabel: `${faircoinAmount} FAIR`,
        payload: 'PEABLE_LOCAL_PREVIEW_NOT_A_PAYMENT',
      });
      setActiveMethod('faircoin');
      setFaircoinView('external');
      navigate('method');
    } else navigate(next === 'review' ? 'confirmation' : next);
  }
  function chooseCard(card: CheckoutCard) {
    externalPending.current = false;
    const nextDraft = {
      ...draft,
      card,
      paymentSelection: { id: card.id, method: 'card', label: `${card.brand} ···· ${card.last4}` },
    };
    setDraft(nextDraft);
    pendingDraft.current = nextDraft;
    setSavedCards((current) =>
      card.saveForLater
        ? [...current.filter((item) => item.id !== card.id), card]
        : current.filter((item) => item.id !== card.id),
    );
  }
  function chooseMethod(selection: CheckoutPaymentSelection) {
    externalPending.current = false;
    continueWithDraft({ ...draft, paymentSelection: selection });
  }
  // Explicit tender fixtures for these scenarios, never a display-currency FX conversion.
  const faircoinAmount =
    scenario === 'trial' ? 0 : scenario === 'physical' ? 56 : cadence === 'year' ? 115 : 12;
  const formatUsd = (minor: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }).format(
      minor / 100,
    );
  const methodDetails: PeableMethodDetails =
    activeMethod === 'installments'
      ? {
          kind: 'installments',
          orderLabel: formatUsd(2800),
          termsVisible: installmentTermsOpen,
          onTerms: () => {
            setInstallmentTermsOpen(true);
            setDirection('forward');
          },
          onTermsBack: () => {
            setInstallmentTermsOpen(false);
            setDirection('backward');
          },
          quote:
            installmentQuote && selectedInstallment
              ? {
                  id: `${selectedInstallment.id}:${installmentBinding}`,
                  currency: 'USD',
                  orderMinorUnits: 2800,
                  dueTodayMinorUnits: installmentQuote.dueTodayMinorUnits,
                  totalMinorUnits: installmentQuote.totalMinorUnits,
                  interestMinorUnits: 0,
                  feesMinorUnits: installmentQuote.feesMinorUnits,
                  payments: installmentQuote.payments.map((payment, index) => ({
                    id: `${index}`,
                    dueOn: new Date(Date.UTC(2026, 10, 3 + payment.dueInDays))
                      .toISOString()
                      .slice(0, 10),
                    amountMinorUnits: payment.amountMinorUnits,
                  })),
                }
              : undefined,
          state: installmentQuote ? previewInstallmentDecision : 'ineligible',
          plans: eligiblePlans.map((plan) => ({
            id: plan.id,
            title: t(`plus.merchantInstallments.${plan.family}`),
            detail: t('plus.checkout.installmentPlan.noInterest'),
          })),
          selectedPlanId: selectedInstallment?.id,
          onPlan: (id) => {
            setSelectedInstallmentId(id);
            setDraft((current) =>
              current.paymentSelection?.method === 'installments'
                ? { ...current, paymentSelection: null }
                : current,
            );
          },
          dueTodayLabel: formatUsd(installmentQuote?.dueTodayMinorUnits ?? 0),
          totalLabel: formatUsd(installmentQuote?.totalMinorUnits ?? 2800),
          feesLabel: formatUsd(installmentQuote?.feesMinorUnits ?? 0),
          interestLabel: formatUsd(0),
          schedule: (installmentQuote?.payments ?? []).map((payment, index) => ({
            id: `${selectedInstallment?.id}:${index}`,
            label: new Date(Date.UTC(2026, 10, 3 + payment.dueInDays)).toLocaleDateString(
              i18n.language,
              { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' },
            ),
            amountLabel: formatUsd(payment.amountMinorUnits),
          })),
          disclosure: [
            t('plus.checkout.installments.preview'),
            merchantInstallmentPreferences.message,
          ]
            .filter(Boolean)
            .join(' '),
          terms: merchantInstallmentPreferences.terms || undefined,
          repayment: customer.simulated ? { label: 'Visa ···· 4242' } : undefined,
          onSelect: () => {
            if (
              !installmentQuote ||
              !selectedInstallment ||
              previewInstallmentDecision !== 'available'
            )
              return;
            chooseMethod({
              id: `installments:${selectedInstallment.id}:${installmentBinding}`,
              method: 'installments',
              label: t(`plus.merchantInstallments.${selectedInstallment.family}`),
              detail: formatUsd(installmentQuote.totalMinorUnits),
            });
          },
        }
      : activeMethod === 'faircoin'
        ? {
            kind: 'faircoin',
            amountLabel: externalTransfer?.amountLabel ?? `${faircoinAmount} FAIR`,
            quoteDescription: '',
            view: faircoinView,
            wallet: customer.simulated
              ? {
                  state: 'ready',
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
                    addressLabel: 'PEABLE_LOCAL_WALLET_TOPUP_PREVIEW_NOT_PAYABLE',
                    onCopy: async (value) => {
                      if (!(await Clipboard.setStringAsync(value)))
                        throw new Error('Clipboard unavailable');
                    },
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
              : customer.kind === 'account'
                ? {
                    state: 'unavailable',
                    canPay: false,
                    onOpen: () => setFaircoinView('wallet'),
                  }
                : undefined,
            external: {
              state: externalTransfer?.phase,
              payload: externalTransfer?.payload ?? 'PEABLE_LOCAL_PREVIEW_NOT_A_PAYMENT',
              addressLabel: 'PEABLE_LOCAL_PREVIEW_NOT_A_PAYMENT',
              onCopy: async (value) => {
                if (!(await Clipboard.setStringAsync(value)))
                  throw new Error('Clipboard unavailable');
              },
              onOpen: () => {
                if (authorizing.current) return;
                if (faircoinAmount === 0) {
                  chooseMethod({
                    id: 'faircoin-external',
                    method: 'faircoin',
                    label: t('plus.checkout.rail.external'),
                  });
                  return;
                }
                externalPending.current = true;
                continueWithDraft({
                  ...draft,
                  paymentSelection: {
                    id: 'faircoin-external',
                    method: 'faircoin',
                    label: t('plus.checkout.rail.external'),
                  },
                });
              },
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
                detail: activeMethod === 'bank' && customer.simulated ? '···· 6789' : undefined,
              }),
          };
  if (showOrder && scenario === 'physical') {
    const payments =
      draft.paymentSelection?.method === 'installments' && installmentQuote
        ? installmentQuote.payments.map((payment, index) => ({
            id: `installment-${index}`,
            date: new Date(Date.UTC(2026, 10, 3 + payment.dueInDays)).toISOString().slice(0, 10),
            amountMinorUnits: payment.amountMinorUnits,
            status: (index === 0 && installmentQuote.dueTodayMinorUnits > 0
              ? 'paid'
              : 'scheduled') as 'paid' | 'scheduled',
            method: draft.paymentSelection?.label,
          }))
        : [
            {
              id: 'paid',
              date: 'November 3, 2026',
              amountMinorUnits: 2800,
              status: 'paid' as const,
            },
          ];
    return (
      <LocalOrderPreview
        paidMinorUnits={request.dueTodayMinorUnits}
        payments={payments}
        onClose={close}
      />
    );
  }
  return (
    <PeableCheckoutSheet
      open
      locale={i18n.language}
      brandState={
        externalTransfer?.phase === 'awaiting' && step === 'method' && faircoinView === 'external'
          ? 'loading'
          : brandState
      }
      methodTitleAlign={activeMethod === 'faircoin' ? 'center' : 'left'}
      methodTitleVariant={activeMethod === 'faircoin' ? 'title-2-semibold' : undefined}
      methodTitle={
        activeMethod === 'faircoin'
          ? t(
              faircoinView === 'wallet'
                ? 'plus.checkout.rail.wallet'
                : faircoinView === 'topup'
                  ? 'plus.checkout.rail.addFunds'
                  : 'plus.checkout.rail.payFaircoin',
            )
          : activeMethod === 'installments'
            ? t('plus.checkout.installments.title')
            : t('plus.checkout.rail.bank')
      }
      accountSummary={
        customer.kind === 'account'
          ? {
              name: customer.displayName || t('plus.checkout.customer.accountLabel'),
              detail: customer.simulated
                ? customer.email
                : t('plus.checkout.customer.accountLabel'),
              supportingRows: [
                {
                  id: 'wallet-balance',
                  title: t('plus.checkout.rail.wallet'),
                  value: customer.simulated
                    ? `${demoBalance} FAIR`
                    : t('plus.checkout.rail.balanceUnavailable'),
                  onPress: () => {
                    setActiveMethod('faircoin');
                    setFaircoinView('wallet');
                    navigate('method');
                  },
                },
              ],
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
      frameKey={
        step === 'method'
          ? `${activeMethod}:${faircoinView}:${selectedInstallment?.id}:${previewInstallmentDecision}:${installmentTermsOpen}`
          : step
      }
      direction={direction}
      onContinue={continueWithDraft}
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
        ].map((key) => [
          key,
          key === 'result.processing' &&
          (externalTransfer?.phase === 'detected' || externalTransfer?.phase === 'processing')
            ? t(`plus.checkout.transfer.${externalTransfer.phase}`)
            : t(`plus.checkout.${key}`),
        ]),
      )}
      cardEntry={
        step === 'card' ? (
          <LocalCheckoutCardEntry
            card={draft.card}
            onCard={chooseCard}
            onDone={() => continueWithDraft(pendingDraft.current)}
          />
        ) : undefined
      }
    />
  );
}
