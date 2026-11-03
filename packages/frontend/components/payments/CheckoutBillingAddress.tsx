import { useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@oxy.so/bloom/typography';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectItemText,
} from '@oxy.so/bloom/select';
import { COUNTRY_CODES } from '@mention/shared-types/job';
import { countryName } from '@/utils/jobVocabulary';

export interface CheckoutBillingAddressValue {
  country: string;
  state: string;
  postalCode: string;
  city: string;
  line1: string;
  line2: string;
}
export const emptyBillingAddress = (): CheckoutBillingAddressValue => ({
  country: '',
  state: '',
  postalCode: '',
  city: '',
  line1: '',
  line2: '',
});
/** Form completeness only; jurisdiction and evidence sufficiency remain server decisions. */
export function billingAddressComplete(value: CheckoutBillingAddressValue): boolean {
  return (
    COUNTRY_CODES.some((country) => country === value.country) &&
    !!value.line1.trim() &&
    !!value.city.trim() &&
    value.city.length <= 100 &&
    value.state.length <= 100 &&
    value.postalCode.length <= 32 &&
    (Object.keys(value) as (keyof CheckoutBillingAddressValue)[]).every(
      (key) =>
        value[key].length <= 200 &&
        Array.from(value[key]).every((character) => character.charCodeAt(0) >= 32),
    )
  );
}
export function CheckoutBillingAddress({
  value,
  onChange,
  locked,
  receiptEmail,
  onReceiptEmailChange,
}: {
  value: CheckoutBillingAddressValue;
  onChange(value: CheckoutBillingAddressValue): void;
  locked: boolean;
  receiptEmail?: string;
  onReceiptEmailChange?(value: string): void;
}) {
  const { t, i18n } = useTranslation();
  const countries = useMemo(() => {
    return COUNTRY_CODES.map((country) => ({
      value: country,
      label: countryName(country, i18n.language),
    })).sort((a, b) => a.label.localeCompare(b.label, i18n.language));
  }, [i18n.language]);
  const fields = [
    ['line1', 'plus.checkout.field.address'],
    ['line2', 'plus.checkout.billing.line2'],
    ['city', 'plus.checkout.field.city'],
    ['state', 'plus.checkout.billing.state'],
    ['postalCode', 'plus.checkout.field.postalCode'],
  ] as const;
  return (
    <View style={{ gap: 16 }}>
      <Text accessibilityRole="header">{t('plus.checkout.billing.title')}</Text>
      {receiptEmail !== undefined && (
        <TextField disabled={locked}>
          <TextFieldInput
            label={t('plus.checkout.email')}
            value={receiptEmail}
            maxLength={254}
            keyboardType="email-address"
            autoCapitalize="none"
            onValueChange={(email) => {
              if (!locked) onReceiptEmailChange?.(email);
            }}
          />
        </TextField>
      )}
      <Select
        value={value.country || undefined}
        disabled={locked}
        onValueChange={(country) => {
          if (!locked) onChange({ ...value, country });
        }}
      >
        <SelectTrigger label={t('plus.checkout.field.country')}>
          <SelectValue placeholder={t('plus.checkout.field.country')} />
        </SelectTrigger>
        <SelectContent
          label={t('plus.checkout.field.country')}
          items={countries}
          renderItem={(country) => (
            <SelectItem value={country.value} label={country.label}>
              <SelectItemText>{country.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
      {fields.map(([field, label]) => (
        <TextField key={field} disabled={locked}>
          <TextFieldInput
            label={t(label)}
            value={value[field]}
            onValueChange={(next) => {
              if (!locked) onChange({ ...value, [field]: next });
            }}
            maxLength={
              field === 'postalCode' ? 32 : field === 'state' || field === 'city' ? 100 : 200
            }
          />
        </TextField>
      ))}
      {locked && <Text>{t('plus.checkout.billing.locked')}</Text>}
    </View>
  );
}
