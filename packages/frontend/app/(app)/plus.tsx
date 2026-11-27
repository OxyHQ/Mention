import { useCheckoutConfiguration } from '@/hooks/useCheckoutConfiguration';
import { captureCheckoutReview, type CheckoutReview } from '@/lib/payments/checkoutReview';
import { PreparedPlusCheckout } from '@/components/payments/PreparedPlusCheckout';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import { useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import { localProviderTestBinding } from '@/lib/payments/localProviderTest';
import { CheckoutPreviewBadge } from '@/components/payments/CheckoutPreviewBadge';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { SubscriptionPrice, type SubscriptionPlan } from '@oxy.so/bloom/subscription-plans';
import { plusPriceMajorUnits, type PlusCadence } from '@/lib/payments/plusCheckout';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { usePlusOffer } from '@/hooks/usePlusOffer';
import { isLocalCheckoutPreview } from '@/lib/payments/checkoutPreview';
import { PlusPaymentSheet } from '@/components/payments/PlusPaymentSheet';
import { PlusDisplayEstimate } from '@/components/payments/PlusDisplayEstimate';
import { useTranslation } from 'react-i18next';

import {
  Button as LButton,
  Embed,
  Group,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  HStack,
  Header,
  Icon,
  Option,
  ScrollView,
  Segmented,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/** Mention Plus is sold individually and is also included with Oxy One. */
export default screen(function PlusScreen() {
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
  const [cadence, setCadence] = useState<PlusCadence>('month');
  const { offer, hasAccess, purchaseAvailable, failed, loading } = usePlusOffer(cadence);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const developmentCheckout = isLocalCheckoutPreview();
  const { user } = useAuth();
  const { activeSessionId } = useOxy();
  const scope = JSON.stringify([
    user?.id,
    activeSessionId,
    cadence,
    offer?.productId,
    offer?.offerId,
    offer?.offerVersion,
    offer?.price?.amountMinorUnits,
    offer?.price?.currency,
    hasAccess,
  ]);
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
    if (developmentCheckout) {
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
          icon: toElement(Icon(RiChat3Line).size('lg').foreground('primary')),
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
          icon: toElement(Icon(RiChat3Line).size('lg').foreground('primary')),
        },
        {
          id: 'mono',
          title: t('plus.benefitMono'),
          description: t('plus.benefitMonoDescription'),
          icon: toElement(Icon(RiPaletteLine).size('lg').foreground('primary')),
        },
      ],
    },
  ];

  const selectedPlan = plans.find((plan) => plan.id === selected);
  return Group(
    ScrollView(
      VStack(
        LText('Mention ', selectedPlan?.label)
          .textStyle('title')
          .font('display-4')
          .weight('semibold')
          .textAlign('center'),
        LText(selectedPlan?.subtitle).textStyle('subtitle').textAlign('center'),
        // A plan's price is the offer (an amount) or this screen's own words for it.
        selectedPlan?.price &&
          typeof selectedPlan.price === 'object' &&
          'amount' in selectedPlan.price
          ? Embed(<SubscriptionPrice {...selectedPlan.price} />)
          : typeof selectedPlan?.price === 'string' && selectedPlan.price
            ? LText(selectedPlan.price).textAlign('center')
            : null,
        HStack(
          VStack(
            Segmented(
              [
                selected,
                (value) => {
                  if (!paymentOpen) setSelected(value);
                },
              ],
              plans.map((plan) => Option(plan.id, plan.label).disabled(paymentOpen)),
            )
              .label(t('plus.selectorLabel'))
              .size('sm'),
          )
            .frame({ minWidth: 'none' })
            .grow(),
          VStack(
            Segmented(
              [
                cadence,
                (value) => {
                  if (!paymentOpen) setCadence(value);
                },
              ],
              Option('month', t('plus.payment.cadenceMonth')).disabled(paymentOpen),
              Option('year', t('plus.payment.cadenceYearShort')).disabled(paymentOpen),
            )
              .label(t('plus.payment.cadenceLabel'))
              .size('sm'),
          )
            .frame({ minWidth: 'none' })
            .grow(),
        )
          .spacing('sm')
          .align('center')
          .testID('plus-plan-selectors'),
        cadence === 'year'
          ? LText(t('plus.payment.annualDiscount')).font('caption-1').textAlign('center')
          : null,
        LGroupedSection(
          Embed(
            selectedPlan?.benefits.map((benefit) =>
              toElement(
                (benefit.description === undefined
                  ? LGroupedSectionItem(benefit.title)
                  : LGroupedSectionItem(benefit.title).description(benefit.description)
                )
                  .leadingView(Embed(benefit.icon))
                  .lines(0)
                  .descriptionLines(0),
                benefit.id,
              ),
            ),
          ),
        ),
        selected === 'plus'
          ? LButton(
              LText(
                t(
                  hasAccess
                    ? 'plus.payment.included'
                    : developmentCheckout || purchaseAvailable
                      ? 'plus.subscribe'
                      : failed
                        ? 'plus.payment.pricingUnavailable'
                        : 'plus.payment.comingSoon',
                ),
              ),
            )
              .size('lg')
              .disabled(hasAccess || loading || (!developmentCheckout && !purchaseAvailable))
              .onPress(() => {
                if (!hasAccess && !loading && (developmentCheckout || purchaseAvailable))
                  openPayment();
              })
          : null,
        LButton(LText(t('plus.exploreOxyOne')))
          .style('plain')
          .tint('neutral')
          .onPress(() => {
            void Linking.openURL('https://oxy.so/one');
          }),
      )
        .padding('horizontal', 'lg')
        .padding('top', '2xl')
        .frame({ width: 'full', maxWidth: '640' })
        .alignSelf('center')
        .spacing('lg'),
      Embed(selected === 'plus' && offer?.price && <PlusDisplayEstimate price={offer.price} />),
      selected === 'plus' && !hasAccess && !purchaseAvailable && !failed && !loading
        ? VStack(
            LText(t('plus.payment.notReady'))
              .frame({ maxWidth: '480' })
              .textAlign('center')
              .foreground('muted'),
          )
            .padding('horizontal', '2xl')
            .margin('top', 'lg')
            .align('center')
        : null,
    ),
    Embed(isLocalCheckoutPreview() && <CheckoutPreviewBadge providerTest={developmentCheckout} />),
    Embed(
      paymentOpen &&
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
        ) : (
          <PlusPaymentSheet cadence={cadence} onClose={closePayment} />
        )),
    ),
  ).header(
    Header()
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );
});
