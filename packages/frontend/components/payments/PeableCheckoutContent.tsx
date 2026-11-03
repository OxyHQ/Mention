import { plusPriceMajorUnits } from '@/lib/payments/plusCheckout';
import { useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { useDialogFrame } from '@oxy.so/bloom/dialog';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiMailLine } from '@oxy.so/bloom/icons/RiMailLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import { RiTruckLine } from '@oxy.so/bloom/icons/RiTruckLine';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { useTranslation } from 'react-i18next';
import {
  checkoutSections,
  nextCheckoutStep,
  type CheckoutCard,
  type CheckoutDraft,
  type CheckoutRequest,
  type CheckoutStep,
} from '@/lib/payments/checkoutFlow';

export interface PeableCheckoutContentProps {
  request: CheckoutRequest;
  draft: CheckoutDraft;
  step: CheckoutStep;
  direction: 'forward' | 'backward';
  onDraft(draft: CheckoutDraft): void;
  onStep(step: CheckoutStep): void;
  onBack(): void;
  onClose(): void;
  onAuthorize(): void;
  savedCards: CheckoutCard[];
  onCard(card: CheckoutCard): void;
}
const logo = require('../../assets/images/peable-checkout.png');

/** Presentation-only checkout: no provider, account, key-storage or money API imports. */
export function PeableCheckoutContent(props: PeableCheckoutContentProps) {
  const {
    request,
    draft,
    step,
    direction,
    onDraft,
    onStep,
    onBack,
    onClose,
    onAuthorize,
    savedCards,
    onCard,
  } = props;
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  useDialogFrame({ key: `peable:${step}`, direction });
  const label = (key: string) => t(`plus.checkout.${key}`);
  const money = (amount: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency: request.currency }).format(
      plusPriceMajorUnits({ currency: request.currency, amountMinorUnits: amount }),
    );
  const groupStyle = {
    marginBottom: 0,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
  };
  const muted = { color: colors.textSecondary, fontSize: 13 };
  const next = nextCheckoutStep(request, draft);
  const title = step === 'review' ? 'Peable' : label(`step.${step}`);
  const cardLabel = draft.card
    ? `${draft.card.brand} ···· ${draft.card.last4}`
    : label('addPayment');
  const sectionText = {
    contact: draft.email || label('addContact'),
    shipping: draft.shipping.address || label('addShipping'),
    delivery: draft.delivery ? label(`delivery.${draft.delivery}`) : label('chooseDelivery'),
    payment: cardLabel,
  };
  const sectionIcons = {
    contact: RiMailLine,
    shipping: RiMapPinLine,
    delivery: RiTruckLine,
    payment: RiBankCardLine,
  };
  const [testCard, setTestCard] = useState<CheckoutCard>(
    draft.card ?? {
      id: 'demo-visa',
      brand: 'Visa' as const,
      last4: '4242',
      saveForLater: false,
    },
  );
  const saveCard = testCard.saveForLater;

  return (
    <View testID="peable-checkout-step" style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {step !== 'review' && step !== 'processing' && step !== 'success' ? (
          <Button
            iconOnly
            appearance="plain"
            icon={RiArrowLeftLine}
            accessibilityLabel={t('common.back')}
            onPress={onBack}
          />
        ) : (
          <View style={{ width: 36 }} />
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Image
            source={logo}
            style={{ width: 27, height: 27 }}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
          <Text style={{ fontSize: 18, fontWeight: '600' }}>{title}</Text>
        </View>
        <Button
          iconOnly
          appearance="plain"
          icon={RiCloseLine}
          accessibilityLabel={t('common.close')}
          onPress={onClose}
        />
      </View>

      {step === 'review' && (
        <>
          <View style={{ alignItems: 'center', gap: 5 }}>
            <Text style={muted}>
              {t('plus.checkout.payMerchant', { merchant: request.merchant })}
            </Text>
            <Text style={{ fontSize: 44, lineHeight: 54, fontWeight: '700', letterSpacing: -1.5 }}>
              {money(request.dueTodayMinorUnits)}
            </Text>
            <Text style={muted}>{label('dueToday')}</Text>
          </View>
          <GroupedSection radius="radius-20" separator="line" style={groupStyle}>
            {request.items.map((item) => (
              <GroupedSectionItem
                key={item.id}
                title={item.name}
                description={`${item.detail} · ${t('plus.checkout.quantity', { count: item.quantity })}`}
                value={money(item.amountMinorUnits)}
                showChevron={false}
                icon={
                  item.image ? (
                    <Image source={item.image} style={{ width: 36, height: 36, borderRadius: 8 }} />
                  ) : request.requiresShipping ? (
                    <RiTruckLine size="md" fill={colors.text} />
                  ) : (
                    <RiBankCardLine size="md" fill={colors.text} />
                  )
                }
              />
            ))}
            <GroupedSectionItem
              title={label('subtotal')}
              value={money(request.items.reduce((total, item) => total + item.amountMinorUnits, 0))}
              showChevron={false}
            />
            <GroupedSectionItem
              title={label('tax')}
              value={label('included')}
              showChevron={false}
            />
          </GroupedSection>
          {request.recurring && (
            <View style={{ gap: 7 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={muted}>{label('recurring')}</Text>
                <Text style={{ fontSize: 13 }}>
                  {money(request.recurring.amountMinorUnits)} / {label(request.recurring.interval)}
                </Text>
              </View>
              {request.recurring.startsOn && (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={muted}>{label('starts')}</Text>
                  <Text style={{ fontSize: 13 }}>{request.recurring.startsOn}</Text>
                </View>
              )}
            </View>
          )}
          {(request.recurring?.renewalTerms || request.recurring?.cancellationTerms) && (
            <View style={{ gap: 4 }}>
              {request.recurring.renewalTerms && (
                <Text style={muted}>{request.recurring.renewalTerms}</Text>
              )}
              {request.recurring.cancellationTerms && (
                <Text style={muted}>{request.recurring.cancellationTerms}</Text>
              )}
            </View>
          )}
          <GroupedSection radius="radius-20" separator="line" style={groupStyle}>
            {checkoutSections(request).map((section) => {
              const Icon = sectionIcons[section];
              return (
                <GroupedSectionItem
                  key={section}
                  title={label(`section.${section}`)}
                  description={sectionText[section]}
                  icon={<Icon size="md" fill={colors.textSecondary} />}
                  accessibilityLabel={`${label(`section.${section}`)}: ${sectionText[section]}`}
                  onPress={() => onStep(section)}
                />
              );
            })}
          </GroupedSection>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontWeight: '600' }}>{label('dueToday')}</Text>
              <Text style={{ fontWeight: '600' }}>{money(request.dueTodayMinorUnits)}</Text>
            </View>
            <Button size="lg" onPress={() => (next === 'review' ? onAuthorize() : onStep(next))}>
              {next === 'review'
                ? request.recurring && request.dueTodayMinorUnits === 0
                  ? label('confirmSubscription')
                  : t('plus.checkout.payAmount', { amount: money(request.dueTodayMinorUnits) })
                : label('continue')}
            </Button>
            <Text style={{ ...muted, textAlign: 'center', fontSize: 11 }}>
              {label('previewNotice')}
            </Text>
          </View>
        </>
      )}

      {step === 'contact' && (
        <>
          <Text style={muted}>{label('contactHint')}</Text>
          <TextFieldInput
            label={label('email')}
            value={draft.email}
            onValueChange={(email) => onDraft({ ...draft, email })}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Button
            size="lg"
            disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())}
            onPress={() => onStep('review')}
          >
            {label('save')}
          </Button>
        </>
      )}
      {step === 'shipping' && (
        <>
          <Text style={muted}>{label('shippingHint')}</Text>
          {(['name', 'address', 'city', 'postalCode', 'country'] as const).map((field) => (
            <TextFieldInput
              key={field}
              label={label(`field.${field}`)}
              value={draft.shipping[field]}
              onValueChange={(value) =>
                onDraft({ ...draft, shipping: { ...draft.shipping, [field]: value } })
              }
            />
          ))}
          <Button
            size="lg"
            disabled={Object.values(draft.shipping).some((value) => !value.trim())}
            onPress={() => onStep('review')}
          >
            {label('save')}
          </Button>
        </>
      )}
      {step === 'delivery' && (
        <>
          <Text style={muted}>{label('deliveryHint')}</Text>
          <GroupedSection radius="radius-20" separator="line" style={groupStyle}>
            {(['standard', 'express'] as const).map((method) => (
              <GroupedSectionItem
                key={method}
                title={label(`delivery.${method}`)}
                description={label(`delivery.${method}Hint`)}
                showChevron={false}
                rightElement={draft.delivery === method ? <Text>✓</Text> : undefined}
                accessibilityState={{ selected: draft.delivery === method }}
                onPress={() => onDraft({ ...draft, delivery: method })}
              />
            ))}
          </GroupedSection>
          <Button size="lg" disabled={!draft.delivery} onPress={() => onStep('review')}>
            {label('save')}
          </Button>
        </>
      )}
      {step === 'payment' && (
        <>
          <Text style={muted}>{label('paymentHint')}</Text>
          {request.paymentMethods.includes('card') && savedCards.length > 0 && (
            <GroupedSection radius="radius-20" separator="line" style={groupStyle}>
              {savedCards.map((card) => (
                <GroupedSectionItem
                  key={card.id}
                  title={`${card.brand} ···· ${card.last4}`}
                  description={label('savedCard')}
                  icon={<RiBankCardLine size="md" fill={colors.text} />}
                  onPress={() => {
                    onCard(card);
                    onStep('review');
                  }}
                />
              ))}
            </GroupedSection>
          )}
          {request.paymentMethods.includes('card') && (
            <>
              <Button size="lg" onPress={() => onStep('card')}>
                {label('addCard')}
              </Button>
              <Text style={{ ...muted, textAlign: 'center' }}>{label('acceptedCards')}</Text>
            </>
          )}
        </>
      )}
      {step === 'card' && (
        <>
          <GroupedSection radius="radius-20" separator="line" style={groupStyle}>
            <GroupedSectionItem
              title={label('secureFields')}
              description={label('cardPlaceholder')}
              descriptionLines={0}
              showChevron={false}
            />
            <GroupedSectionItem
              title={label('cardNumber')}
              description={label('testCardOnly')}
              value={`···· ${testCard.last4}`}
              showChevron={false}
            />
          </GroupedSection>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['Visa', 'Mastercard'] as const).map((brand) => (
              <Button
                key={brand}
                appearance={testCard.brand === brand ? 'subtle' : 'outline'}
                onPress={() =>
                  setTestCard({
                    id: `demo-${brand}`,
                    brand,
                    last4: brand === 'Visa' ? '4242' : '4444',
                    saveForLater: saveCard,
                  })
                }
              >
                {brand}
              </Button>
            ))}
          </View>
          <Checkbox
            checked={saveCard}
            onCheckedChange={(checked) => setTestCard({ ...testCard, saveForLater: checked })}
            label={label('saveCard')}
            description={label('saveCardHint')}
          />
          <Button
            size="lg"
            onPress={() => {
              onCard({ ...testCard, saveForLater: saveCard });
              onStep('review');
            }}
          >
            {label('useCard')}
          </Button>
        </>
      )}
      {(step === 'processing' || step === 'success' || step === 'failure') && (
        <View style={{ alignItems: 'center', gap: 18, paddingVertical: 26 }}>
          {step === 'processing' ? (
            <ActivityIndicator size="large" color={colors.primary} />
          ) : (
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: colors.backgroundSecondary,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 30 }}>{step === 'success' ? '✓' : '!'}</Text>
            </View>
          )}
          <Text style={{ fontSize: 23, fontWeight: '600', textAlign: 'center' }}>
            {label(`result.${step}`)}
          </Text>
          <Text style={{ ...muted, textAlign: 'center', maxWidth: 330 }}>
            {label(`result.${step}Hint`)}
          </Text>
          {step !== 'processing' && (
            <View style={{ alignSelf: 'stretch' }}>
              <Button onPress={step === 'success' ? onClose : () => onStep('review')}>
                {step === 'success' ? label('done') : label('tryAgain')}
              </Button>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
