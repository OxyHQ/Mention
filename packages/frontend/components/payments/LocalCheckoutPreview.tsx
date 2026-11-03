import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { useTranslation } from 'react-i18next';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import type { PlusCadence } from '@/lib/payments/plusCheckout';
import {
  emptyCheckoutDraft,
  nextCheckoutStep,
  type CheckoutAuthorization,
  type CheckoutCard,
  type CheckoutDraft,
  type CheckoutRequest,
  type CheckoutScenario,
  type CheckoutStep,
  type PreviewOutcome,
} from '@/lib/payments/checkoutFlow';
import { PeableCheckoutContent } from './PeableCheckoutContent';

/** Local memory-only adapter. This file deliberately has no payment, storage or entitlement APIs. */
export function LocalCheckoutPreview({
  cadence,
  scenario,
  outcome,
  onClose,
  authorize,
}: {
  cadence: PlusCadence;
  scenario: CheckoutScenario;
  outcome: PreviewOutcome;
  onClose(): void;
} & CheckoutAuthorization) {
  const { offer, loading, failed } = usePlusOffer(cadence);
  const [reviewedOffer, setReviewedOffer] = useState(offer);
  useEffect(() => {
    if (!reviewedOffer && offer) setReviewedOffer(offer);
  }, [offer, reviewedOffer]);
  const { t } = useTranslation();
  const [step, setStep] = useState<CheckoutStep>('review');
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [draft, setDraft] = useState<CheckoutDraft>(() => ({
    ...emptyCheckoutDraft(),
    email: 'alex@example.test',
  }));
  const [savedCards, setSavedCards] = useState<CheckoutCard[]>([]);
  const history = useRef<CheckoutStep[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(true);
  const authorizing = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const displayOffer =
    scenario === 'trial'
      ? {
          displayName: t('plus.checkout.demoTrialItem'),
          price: { currency: 'USD', amountMinorUnits: 599 },
        }
      : reviewedOffer;
  if (!displayOffer?.price && scenario !== 'physical')
    return (
      <Dialog open onClose={onClose} placement="bottom" detached panelStyle={{ maxWidth: 540 }}>
        <View style={{ padding: 24, gap: 16 }}>
          <Text>
            {t(
              loading ? 'common.loading' : failed ? 'plus.payment.failed' : 'plus.payment.notReady',
            )}
          </Text>
          <Button onPress={onClose}>{t('common.close')}</Button>
        </View>
      </Dialog>
    );
  const price = displayOffer?.price;

  const request: CheckoutRequest =
    scenario === 'physical'
      ? {
          merchant: t('plus.checkout.demoMerchant'),
          currency: 'USD',
          dueTodayMinorUnits: 2800,
          items: [
            {
              id: 'demo-item',
              name: t('plus.checkout.demoItem'),
              detail: t('plus.checkout.demoItemDetail'),
              quantity: 1,
              amountMinorUnits: 2800,
            },
          ],
          requiresShipping: true,
          paymentMethods: ['card'],
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
              image:
                scenario === 'subscription'
                  ? require('../../assets/images/mention-icon.png')
                  : undefined,
              quantity: 1,
              amountMinorUnits: scenario === 'trial' ? 0 : (price?.amountMinorUnits ?? 0),
            },
          ],
          requiresShipping: false,
          paymentMethods: ['card'],
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
    if (next === step) return;
    clearTimeout(timer.current);
    setDirection(next === 'review' ? 'backward' : 'forward');
    if (next === 'review') history.current = [];
    else history.current.push(step);
    setStep(next);
  }
  function back() {
    clearTimeout(timer.current);
    setDirection('backward');
    setStep(history.current.pop() ?? 'review');
  }
  async function simulateAuthorization() {
    if (authorizing.current || nextCheckoutStep(request, draft) !== 'review') return;
    authorizing.current = true;
    setDirection('forward');
    setStep('processing');
    try {
      if (authorize && (await authorize()) !== 'authorized') {
        if (active.current) setStep('review');
        authorizing.current = false;
        return;
      }
      if (!active.current) return;
      if (outcome !== 'loading')
        timer.current = setTimeout(() => {
          if (active.current) setStep(outcome);
          authorizing.current = false;
        }, 1000);
    } catch {
      if (active.current) setStep('failure');
      authorizing.current = false;
    }
  }
  function chooseCard(card: CheckoutCard) {
    setDraft((current) => ({ ...current, card }));
    setSavedCards((current) =>
      card.saveForLater
        ? [...current.filter((item) => item.id !== card.id), card]
        : current.filter((item) => item.id !== card.id),
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      placement="bottom"
      detached
      showHandle={false}
      maxWidth={540}
      panelStyle={{ maxWidth: 540 }}
    >
      <PeableCheckoutContent
        request={request}
        draft={draft}
        step={step}
        direction={direction}
        onDraft={setDraft}
        onStep={navigate}
        onBack={back}
        onClose={onClose}
        onAuthorize={() => {
          void simulateAuthorization();
        }}
        savedCards={savedCards}
        onCard={chooseCard}
      />
    </Dialog>
  );
}
