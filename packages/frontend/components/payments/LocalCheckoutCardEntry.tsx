import { useId, useState } from 'react';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import {
  CardForm,
  CARD_FORM_EMPTY_VALUE,
  cardDigits,
  cardExpiryIsWellFormed,
  cardNumberIsWellFormed,
  cardSecurityCodeIsWellFormed,
  matchCardScheme,
  type CardFormValue,
  type CardScheme,
} from '@oxy.so/bloom/card-form';
import type { CheckoutCard } from '@peable.to/sdk/checkout/ui';
import { useTranslation } from 'react-i18next';

// Recognise only the two familiar local fixture numbers, not a processor's live BIN table.
const LOCAL_CARD_SCHEMES: readonly CardScheme[] = [
  { id: 'visa-fixture', name: 'Visa', prefixes: ['4242424242424242'], lengths: [16] },
  { id: 'mastercard-fixture', name: 'Mastercard', prefixes: ['5555555555554444'], lengths: [16] },
];

/** Local-only input state. Unmount on Back/close; only masked metadata leaves this component. */
export function LocalCheckoutCardEntry({
  onCard,
  onDone,
}: {
  card: CheckoutCard | null;
  onCard(card: CheckoutCard): void;
  onDone(): void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`plus.checkout.${key}`);
  const id = useId();
  const [value, setValue] = useState<CardFormValue>(() => ({ ...CARD_FORM_EMPTY_VALUE }));
  const [saveCard, setSaveCard] = useState(false);
  const scheme = matchCardScheme(cardDigits(value.number), LOCAL_CARD_SCHEMES);
  const valid =
    cardNumberIsWellFormed(value.number, scheme) &&
    cardExpiryIsWellFormed(value.expiry) &&
    cardSecurityCodeIsWellFormed(value.securityCode, scheme) &&
    ['US', 'CA', 'ES'].includes(value.country) &&
    value.postcode.trim().length > 0;
  return (
    <>
      <CardForm
        testID="local-checkout-card-form"
        accessibilityLabel={label('secureFields')}
        value={value}
        onValueChange={setValue}
        schemes={LOCAL_CARD_SCHEMES}
        fields={{ name: false, country: true, postcode: true }}
        countries={[
          { value: 'US', label: label('card.countryUS') },
          { value: 'CA', label: label('card.countryCA') },
          { value: 'ES', label: label('card.countryES') },
        ]}
        labels={{
          number: label('cardNumber'),
          expiry: label('card.expiry'),
          securityCode: label('card.securityCode'),
          country: label('card.country'),
          postcode: label('card.postcode'),
        }}
        secureSecurityCode
        required
      />
      <Checkbox
        checked={saveCard}
        onCheckedChange={setSaveCard}
        label={label('saveCard')}
        description={label('saveCardHint')}
      />
      <Button
        size="lg"
        disabled={!valid}
        onPress={() => {
          if (!valid) return;
          const metadata: CheckoutCard = {
            id: `local-card-${id}`,
            brand: scheme?.name ?? label('card.generic'),
            last4: cardDigits(value.number).slice(-4),
            saveForLater: saveCard,
          };
          setValue({ ...CARD_FORM_EMPTY_VALUE });
          onCard(metadata);
          onDone();
        }}
      >
        {label('continue')}
      </Button>
    </>
  );
}
