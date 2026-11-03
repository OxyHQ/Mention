import { useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import {
  createLocalProviderTestBinding,
  localProviderTestBinding,
} from '@/lib/payments/localProviderTest';
import { MerchantInstallmentSettings } from '@/components/payments/MerchantInstallmentSettings';
import {
  DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES,
  type InstallmentPreviewDecision,
} from '@/lib/payments/merchantInstallmentPreview';
import { CheckoutPreviewBadge } from '@/components/payments/CheckoutPreviewBadge';
import { useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { SubscriptionPlans, type SubscriptionPlan } from '@oxy.so/bloom/subscription-plans';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { plusPriceMajorUnits, type PlusCadence } from '@/lib/payments/plusCheckout';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import { CheckoutPreviewControls } from '@/components/payments/CheckoutPreviewControls';
import { isLocalCheckoutPreview } from '@/lib/payments/checkoutPreview';
import type {
  CheckoutScenario,
  PreviewOutcome,
  CheckoutCustomerMode,
} from '@/lib/payments/checkoutPreview';
import { PlusPaymentSheet } from '@/components/payments/PlusPaymentSheet';
import { PlusDisplayEstimate } from '@/components/payments/PlusDisplayEstimate';
import { useTranslation } from 'react-i18next';

/** Mention Plus is sold individually and is also included with Oxy One. */
export default function PlusScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ '#': string }>();
  const [providerTestBinding, setProviderTestBinding] = useState(() =>
    localProviderTestBinding(
      typeof window === 'undefined' ? '' : (window.location?.href ?? ''),
      isLocalCheckoutPreview(),
    ),
  );
  useEffect(() => {
    if (!providerTestBinding || typeof window === 'undefined' || !window.location) return;
    if (!routeParams['#'] && !window.location.hash) return;
    const clean = new URL(window.location.href);
    clean.hash = '';
    // Clear both Expo Router's hash parameter and browser history; otherwise navigation restores the capability.
    router.setParams({ '#': '' });
    window.history.replaceState(window.history.state, '', clean.toString());
  }, [providerTestBinding, router, routeParams['#']]);
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const [cadence, setCadence] = useState<PlusCadence>('month');
  const { offer, hasAccess, purchaseAvailable, failed, loading } = usePlusOffer(cadence);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [localMode, setLocalMode] = useState<'provider' | 'preview'>('provider');
  const providerMode = isLocalCheckoutPreview() && localMode === 'provider';
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const bootstrapOperation = useRef<string | null>(null);
  const bootstrapAbort = useRef<AbortController | null>(null);
  useEffect(() => () => bootstrapAbort.current?.abort(), []);
  const openPayment = async () => {
    if (bootstrapAbort.current || paymentOpen) return;
    if (!providerMode || providerTestBinding) {
      setPaymentOpen(true);
      return;
    }
    const controller = new AbortController();
    bootstrapAbort.current = controller;
    bootstrapOperation.current ??= `mention_${crypto.randomUUID()}`;
    setBootstrapBusy(true);
    setBootstrapFailed(false);
    try {
      const binding = await createLocalProviderTestBinding(
        bootstrapOperation.current,
        window.location.href,
        isLocalCheckoutPreview(),
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setProviderTestBinding(binding);
        setPaymentOpen(true);
      }
    } catch {
      if (!controller.signal.aborted) setBootstrapFailed(true);
    } finally {
      if (!controller.signal.aborted) setBootstrapBusy(false);
      bootstrapAbort.current = null;
    }
  };
  const [selected, setSelected] = useState('plus');
  const [previewScenario, setPreviewScenario] = useState<CheckoutScenario>('subscription');
  const [previewCustomerMode, setPreviewCustomerMode] = useState<CheckoutCustomerMode>('automatic');
  const [previewInstallmentDecision, setPreviewInstallmentDecision] =
    useState<InstallmentPreviewDecision>('available');
  const [previewIncomingFunds, setPreviewIncomingFunds] = useState(false);
  const [previewSoundEnabled, setPreviewSoundEnabled] = useState(true);
  const [previewOutcome, setPreviewOutcome] = useState<PreviewOutcome>('success');
  const [merchantInstallmentPreferences, setMerchantInstallmentPreferences] = useState(
    DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES,
  );

  const plans: SubscriptionPlan[] = [
    {
      id: 'free',
      label: t('plus.planFree'),
      subtitle: t('plus.freeSubtitle'),
      price: t('plus.planFree'),
      benefits: [
        {
          id: 'social',
          title: t('plus.freeBenefitSocial'),
          icon: <RiChat3Line size="lg" fill={colors.primary} />,
        },
      ],
    },
    {
      id: 'plus',
      label: 'Plus',
      subtitle: t('plus.plusSubtitle'),
      price: offer?.price
        ? {
            amount: plusPriceMajorUnits(offer.price),
            currency: offer.price.currency,
            locale: i18n.language,
            suffix: t(`plus.payment.priceSuffix.${offer.price.interval}`),
            description: offer.displayName,
          }
        : t(
            failed
              ? 'plus.payment.pricingUnavailable'
              : loading
                ? 'common.loading'
                : 'plus.payment.comingSoon',
          ),
      benefits: [
        {
          id: 'connect',
          title: t('plus.benefitConnect'),
          icon: <RiGroupLine size="lg" fill={colors.primary} />,
        },
        {
          id: 'ai',
          title: t('plus.benefitAi'),
          description: t('plus.benefitAiDescription'),
          icon: <RiQuillPenLine size="lg" fill={colors.primary} />,
        },
      ],
    },
  ];

  return (
    <Screen header={<PageHeader backLabel={t('common.back', { defaultValue: 'Back' })} />}>
      <ScreenScrollView>
        {isLocalCheckoutPreview() && (
          <View style={{ padding: 24, gap: 12 }}>
            <SegmentedControl<'provider' | 'preview'>
              label={t('plus.checkout.providerTest.mode')}
              type="radio"
              value={localMode}
              onValueChange={(value) => {
                if (!paymentOpen && !bootstrapBusy) {
                  setLocalMode(value);
                  if (value === 'provider') setCadence('month');
                  setBootstrapFailed(false);
                }
              }}
            >
              <SegmentedControlItem value="provider" disabled={paymentOpen || bootstrapBusy}>
                <SegmentedControlItemText>
                  {t('plus.checkout.providerTest.mode')}
                </SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="preview" disabled={paymentOpen || bootstrapBusy}>
                <SegmentedControlItemText>
                  {t('plus.checkout.providerTest.visualPreview')}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
            {providerMode && <Text>{t('plus.checkout.providerTest.entryDescription')}</Text>}
            {bootstrapBusy && <Text>{t('plus.checkout.providerTest.loading')}</Text>}
            {bootstrapFailed && (
              <Text accessibilityRole="alert">
                {t('plus.checkout.providerTest.bootstrapFailed')}
              </Text>
            )}
          </View>
        )}
        <SegmentedControl<PlusCadence>
          label={t('plus.payment.cadenceLabel')}
          type="radio"
          value={cadence}
          onValueChange={(value) => {
            if (!paymentOpen) setCadence(value);
          }}
        >
          <SegmentedControlItem
            value="month"
            disabled={paymentOpen || providerMode || bootstrapBusy}
          >
            <SegmentedControlItemText>{t('plus.payment.cadenceMonth')}</SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem
            value="year"
            disabled={paymentOpen || providerMode || bootstrapBusy}
          >
            <SegmentedControlItemText>{t('plus.payment.cadenceYear')}</SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
        <SubscriptionPlans
          productName="Mention"
          plans={plans}
          value={selected}
          onValueChange={setSelected}
          selectorLabel={t('plus.selectorLabel')}
          primaryAction={
            selected === 'plus'
              ? {
                  label: t(hasAccess ? 'plus.payment.included' : 'plus.subscribe'),
                  disabled: hasAccess || loading || bootstrapBusy,
                  onPress: () => {
                    if (!hasAccess && !loading) void openPayment();
                  },
                }
              : undefined
          }
          moreBenefits={{
            label: t('plus.exploreOxyOne'),
            onPress: () => {
              void Linking.openURL('https://oxy.so/one');
            },
          }}
        />
        {selected === 'plus' && offer?.price && <PlusDisplayEstimate price={offer.price} />}
        {selected === 'plus' && !hasAccess && !purchaseAvailable && !failed && !loading && (
          <View style={{ paddingHorizontal: 24, marginTop: 16, alignItems: 'center' }}>
            <Text style={{ maxWidth: 480, textAlign: 'center', color: colors.textSecondary }}>
              {t('plus.payment.notReady')}
            </Text>
          </View>
        )}
        {isLocalCheckoutPreview() && !providerMode && (
          <CheckoutPreviewControls
            installmentDecision={previewInstallmentDecision}
            onInstallmentDecision={setPreviewInstallmentDecision}
            incomingFunds={previewIncomingFunds}
            onIncomingFunds={setPreviewIncomingFunds}
            soundEnabled={previewSoundEnabled}
            onSoundEnabled={setPreviewSoundEnabled}
            customerMode={previewCustomerMode}
            onCustomerMode={setPreviewCustomerMode}
            scenario={previewScenario}
            outcome={previewOutcome}
            onScenario={setPreviewScenario}
            onOutcome={setPreviewOutcome}
          />
        )}
        {isLocalCheckoutPreview() && !providerMode && (
          <View style={{ marginHorizontal: 24, marginBottom: 24 }}>
            <MerchantInstallmentSettings
              value={merchantInstallmentPreferences}
              onChange={setMerchantInstallmentPreferences}
            />
          </View>
        )}
      </ScreenScrollView>
      {isLocalCheckoutPreview() && <CheckoutPreviewBadge providerTest={providerMode} />}
      {paymentOpen && (
        <PlusPaymentSheet
          providerTestBinding={providerMode ? (providerTestBinding ?? undefined) : undefined}
          previewInstallmentDecision={previewInstallmentDecision}
          merchantInstallmentPreferences={merchantInstallmentPreferences}
          previewCustomerMode={previewCustomerMode}
          previewScenario={previewScenario}
          previewOutcome={previewOutcome}
          previewSoundEnabled={previewSoundEnabled}
          previewIncomingFunds={previewIncomingFunds}
          cadence={cadence}
          onClose={() => {
            setPaymentOpen(false);
            setProviderTestBinding(null);
            bootstrapOperation.current = null;
          }}
        />
      )}
    </Screen>
  );
}
