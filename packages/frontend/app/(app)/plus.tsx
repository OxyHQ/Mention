import { useState } from 'react';
import { Linking } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { SubscriptionPlans, type SubscriptionPlan } from '@oxy.so/bloom/subscription-plans';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import { PlusPaymentSheet } from '@/components/payments/PlusPaymentSheet';
import { useTranslation } from 'react-i18next';

/** Mention Plus is sold individually and is also included with Oxy One. */
export default function PlusScreen() {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const { offer, hasAccess } = usePlusOffer();
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
            amount: offer.price.amountMinorUnits / 100,
            currency: offer.price.currency,
            locale: i18n.language,
            suffix: t(`plus.payment.priceSuffix.${offer.price.interval}`),
            description: offer.displayName,
          }
        : t('plus.payment.pricingUnavailable'),
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
                  disabled: hasAccess,
                  onPress: () => setPaymentOpen(true),
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
        <Text>{t('plus.payment.oneIncluded')}</Text>
      </ScreenScrollView>
      {paymentOpen && <PlusPaymentSheet onClose={() => setPaymentOpen(false)} />}
    </Screen>
  );
}
