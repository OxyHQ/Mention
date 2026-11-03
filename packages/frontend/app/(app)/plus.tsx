import { ProductionPlusCheckout } from '@/components/payments/ProductionPlusCheckout';
import { useProductionCheckoutConfiguration } from '@/hooks/useProductionCheckoutConfiguration';
import { useCheckoutConfiguration } from '@/hooks/useCheckoutConfiguration';
import { captureCheckoutReview, type CheckoutReview } from '@/lib/payments/checkoutReview';
import { PreparedPlusCheckout } from '@/components/payments/PreparedPlusCheckout';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import { useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import { localProviderTestBinding } from '@/lib/payments/localProviderTest';
import { CheckoutPreviewBadge } from '@/components/payments/CheckoutPreviewBadge';
import { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { SubscriptionPrice, type SubscriptionPlan } from '@oxy.so/bloom/subscription-plans';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { plusPriceMajorUnits, type PlusCadence } from '@/lib/payments/plusCheckout';
import { Text, Title, Subtitle } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import { isLocalCheckoutPreview } from '@/lib/payments/checkoutPreview';
import { PlusPaymentSheet } from '@/components/payments/PlusPaymentSheet';
import { PlusDisplayEstimate } from '@/components/payments/PlusDisplayEstimate';
import { useTranslation } from 'react-i18next';

/** Mention Plus is sold individually and is also included with Oxy One. */
export default function PlusScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ '#': string }>();
  const [checkoutBinding, setCheckoutBinding] = useState(() =>
    localProviderTestBinding(
      typeof window === 'undefined' ? '' : (window.location?.href ?? ''),
      isLocalCheckoutPreview(),
    ),
  );
  useEffect(() => {
    if (!checkoutBinding || typeof window === 'undefined' || !window.location) return;
    if (!routeParams['#'] && !window.location.hash) return;
    const clean = new URL(window.location.href);
    clean.hash = '';
    // Clear both Expo Router's hash parameter and browser history; otherwise navigation restores the capability.
    router.setParams({ '#': '' });
    window.history.replaceState(window.history.state, '', clean.toString());
  }, [checkoutBinding, router, routeParams['#']]);
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const [cadence, setCadence] = useState<PlusCadence>('month');
  const {
    offer,
    binding: offerBinding,
    hasAccess,
    purchaseAvailable,
    failed,
    loading,
  } = usePlusOffer(cadence);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const developmentCheckout = isLocalCheckoutPreview();
  const { user, canUsePrivateApi, signIn } = useAuth();
  const { activeSessionId } = useOxy();
  const scope = JSON.stringify([
    user?.id,
    activeSessionId,
    canUsePrivateApi,
    cadence,
    offer?.productId,
    offer?.offerId,
    offer?.offerVersion,
    offer?.price?.amountMinorUnits,
    offer?.price?.currency,
    hasAccess,
  ]);
  const productionCheckout = !developmentCheckout && Platform.OS === 'web';
  const productionConfiguration = useProductionCheckoutConfiguration(
    productionCheckout && purchaseAvailable,
    captureCheckoutReview(offer),
    scope,
  );
  const configuration = useCheckoutConfiguration(
    developmentCheckout,
    user?.id,
    activeSessionId,
    scope,
  );
  const [preparation, setPreparation] = useState<{
    review: CheckoutReview;
    operationKey: string;
    scope: string;
  } | null>(null);
  const closePayment = () => {
    setPaymentOpen(false);
    setPreparation(null);
    setCheckoutBinding(null);
  };
  useEffect(() => {
    if (preparation && preparation.scope !== scope) {
      setPaymentOpen(false);
      setPreparation(null);
      setCheckoutBinding(null);
    }
  }, [scope, preparation]);
  const openPayment = () => {
    if (paymentOpen) return;
    if (productionCheckout && !canUsePrivateApi) {
      void signIn();
      return;
    }
    if (developmentCheckout || productionCheckout) {
      const review = captureCheckoutReview(offer);
      if (!review || review.interval !== cadence) {
        toast(t('plus.checkout.providerTest.bootstrapFailed'), { type: 'error' });
        return;
      }
      setPreparation({ review, operationKey: `mention_${crypto.randomUUID()}`, scope });
    }
    setPaymentOpen(true);
  };
  const [selected, setSelected] = useState('plus');
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
          id: 'social',
          title: t('plus.freeBenefitSocial'),
          icon: <RiChat3Line size="lg" fill={colors.primary} />,
        },
        {
          id: 'mono',
          title: t('plus.benefitMono'),
          description: t('plus.benefitMonoDescription'),
          icon: <RiPaletteLine size="lg" fill={colors.primary} />,
        },
      ],
    },
  ];

  const selectedPlan = plans.find((plan) => plan.id === selected);
  return (
    <Screen header={<PageHeader backLabel={t('common.back', { defaultValue: 'Back' })} />}>
      <ScreenScrollView>
        <View
          style={{
            width: '100%',
            maxWidth: 640,
            alignSelf: 'center',
            gap: 16,
            paddingHorizontal: 16,
            paddingTop: 24,
          }}
        >
          <Title variant="display-4-semibold" style={{ textAlign: 'center' }}>
            Mention {selectedPlan?.label}
          </Title>
          <Subtitle style={{ textAlign: 'center' }}>{selectedPlan?.subtitle}</Subtitle>
          {selectedPlan?.price &&
            (typeof selectedPlan.price === 'object' && 'amount' in selectedPlan.price ? (
              <SubscriptionPrice {...selectedPlan.price} />
            ) : (
              <Text style={{ textAlign: 'center' }}>{selectedPlan.price}</Text>
            ))}
          <View
            testID="plus-plan-selectors"
            style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <SegmentedControl
                label={t('plus.selectorLabel')}
                type="radio"
                size="sm"
                value={selected}
                onValueChange={(value) => {
                  if (!paymentOpen) setSelected(value);
                }}
              >
                {plans.map((plan) => (
                  <SegmentedControlItem key={plan.id} value={plan.id} disabled={paymentOpen}>
                    <SegmentedControlItemText>{plan.label}</SegmentedControlItemText>
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <SegmentedControl<PlusCadence>
                label={t('plus.payment.cadenceLabel')}
                type="radio"
                size="sm"
                value={cadence}
                onValueChange={(value) => {
                  if (!paymentOpen) setCadence(value);
                }}
              >
                <SegmentedControlItem value="month" disabled={paymentOpen}>
                  <SegmentedControlItemText>
                    {t('plus.payment.cadenceMonth')}
                  </SegmentedControlItemText>
                </SegmentedControlItem>
                <SegmentedControlItem value="year" disabled={paymentOpen}>
                  <SegmentedControlItemText>
                    {t('plus.payment.cadenceYearShort')}
                  </SegmentedControlItemText>
                </SegmentedControlItem>
              </SegmentedControl>
            </View>
          </View>
          {cadence === 'year' && (
            <Text variant="caption-1-regular" style={{ textAlign: 'center' }}>
              {t('plus.payment.annualDiscount')}
            </Text>
          )}
          <GroupedSection>
            {selectedPlan?.benefits.map((benefit) => (
              <GroupedSectionItem
                key={benefit.id}
                title={benefit.title}
                description={benefit.description}
                icon={benefit.icon}
                titleNumberOfLines={0}
                descriptionLines={0}
              />
            ))}
          </GroupedSection>
          {selected === 'plus' && (
            <Button
              size="lg"
              disabled={hasAccess || loading || (!developmentCheckout && !purchaseAvailable)}
              onPress={() => {
                if (!hasAccess && !loading && (developmentCheckout || purchaseAvailable))
                  openPayment();
              }}
            >
              {t(
                hasAccess
                  ? 'plus.payment.included'
                  : developmentCheckout || purchaseAvailable
                    ? 'plus.subscribe'
                    : failed
                      ? 'plus.payment.pricingUnavailable'
                      : 'plus.payment.comingSoon',
              )}
            </Button>
          )}
          <Button
            appearance="plain"
            tone="neutral"
            onPress={() => {
              void Linking.openURL('https://oxy.so/one');
            }}
          >
            {t('plus.exploreOxyOne')}
          </Button>
        </View>
        {selected === 'plus' && offer?.price && <PlusDisplayEstimate price={offer.price} />}
        {selected === 'plus' && !hasAccess && !purchaseAvailable && !failed && !loading && (
          <View style={{ paddingHorizontal: 24, marginTop: 16, alignItems: 'center' }}>
            <Text style={{ maxWidth: 480, textAlign: 'center', color: colors.textSecondary }}>
              {t('plus.payment.notReady')}
            </Text>
          </View>
        )}
      </ScreenScrollView>
      {isLocalCheckoutPreview() && <CheckoutPreviewBadge providerTest={developmentCheckout} />}
      {paymentOpen &&
        (developmentCheckout ? (
          preparation && preparation.scope === scope ? (
            <PreparedPlusCheckout
              key={preparation.operationKey}
              review={preparation.review}
              configuration={configuration}
              href={typeof window === 'undefined' ? '' : (window.location?.href ?? '')}
              operationKey={preparation.operationKey}
              initialBinding={checkoutBinding ?? undefined}
              onClose={closePayment}
            />
          ) : null
        ) : productionCheckout ? (
          preparation && preparation.scope === scope && offerBinding ? (
            <ProductionPlusCheckout
              key={preparation.operationKey}
              review={preparation.review}
              offerBinding={offerBinding}
              configuration={productionConfiguration}
              onClose={closePayment}
            />
          ) : null
        ) : (
          <PlusPaymentSheet cadence={cadence} onClose={closePayment} />
        ))}
    </Screen>
  );
}
