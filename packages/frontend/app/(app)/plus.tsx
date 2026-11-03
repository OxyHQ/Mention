import { useState } from 'react';
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
import { PlusPaymentSheet } from '@/components/payments/PlusPaymentSheet';
import { PlusDisplayEstimate } from '@/components/payments/PlusDisplayEstimate';
import { useTranslation } from 'react-i18next';

/** Mention Plus is sold individually and is also included with Oxy One. */
export default function PlusScreen() {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const [cadence, setCadence] = useState<PlusCadence>('month');
  const { offer, hasAccess, purchaseAvailable, failed, loading } = usePlusOffer(cadence);
  const [paymentOpen, setPaymentOpen] = useState(false);
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
        <SegmentedControl<PlusCadence>
          label={t('plus.payment.cadenceLabel')}
          type="radio"
          value={cadence}
          onValueChange={(value) => {
            if (!paymentOpen) setCadence(value);
          }}
        >
          <SegmentedControlItem value="month" disabled={paymentOpen}>
            <SegmentedControlItemText>{t('plus.payment.cadenceMonth')}</SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="year" disabled={paymentOpen}>
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
                  label: t(
                    hasAccess
                      ? 'plus.payment.included'
                      : purchaseAvailable
                        ? 'plus.subscribe'
                        : failed
                          ? 'plus.payment.pricingUnavailable'
                          : 'plus.payment.comingSoon',
                  ),
                  disabled: hasAccess || !purchaseAvailable,
                  onPress: () => {
                    if (purchaseAvailable && !hasAccess) setPaymentOpen(true);
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
      </ScreenScrollView>
      {paymentOpen && <PlusPaymentSheet cadence={cadence} onClose={() => setPaymentOpen(false)} />}
    </Screen>
  );
}
