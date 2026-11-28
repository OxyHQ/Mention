import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Switch } from '@oxy.so/bloom/switch';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from 'react-i18next';
import {
  INSTALLMENT_CAPABILITY_FIXTURES,
  validMerchantInstallmentPreferences,
  type MerchantInstallmentPreferences,
} from '@/lib/payments/merchantInstallmentPreview';

function toggle<T>(values: readonly T[], value: T, enabled: boolean): readonly T[] {
  return enabled
    ? [...values.filter((item) => item !== value), value]
    : values.filter((item) => item !== value);
}
function parseAmount(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return Number.NaN;
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Merchant persona controls only local preferences; provider terms and approval are not editable. */
export function MerchantInstallmentSettings({
  value,
  onChange,
}: {
  value: MerchantInstallmentPreferences;
  onChange(value: MerchantInstallmentPreferences): void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`plus.merchantInstallments.${key}`);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [minimum, setMinimum] = useState('');
  const [maximum, setMaximum] = useState('');
  const next = {
    ...draft,
    minMinorUnits: parseAmount(minimum),
    maxMinorUnits: parseAmount(maximum),
  };
  const valid = validMerchantInstallmentPreferences(next);
  return (
    <>
      <Button
        appearance="outline"
        onPress={() => {
          setDraft(value);
          setMinimum((value.minMinorUnits / 100).toFixed(2));
          setMaximum((value.maxMinorUnits / 100).toFixed(2));
          setOpen(true);
        }}
      >
        {label('open')}
      </Button>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          placement="bottom"
          detached
          contentPadding={0}
          panelStyle={{ maxWidth: 540 }}
          header={{ title: label('title'), showClose: true, largeTitle: false }}
        >
          <View style={{ gap: 16, paddingHorizontal: 20, paddingBottom: 20 }}>
            <GroupedSection footer={label('providerBoundary')}>
              <GroupedSectionItem
                title={label('enabled')}
                rightElement={
                  <Switch
                    accessibilityLabel={label('enabled')}
                    checked={draft.enabled}
                    onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                  />
                }
              />
            </GroupedSection>
            <GroupedSection title={label('families')}>
              {INSTALLMENT_CAPABILITY_FIXTURES.map((capability) => (
                <GroupedSectionItem
                  key={capability.id}
                  title={label(capability.family)}
                  description={capability.available ? undefined : label('providerUnavailable')}
                  rightElement={
                    <Switch
                      accessibilityLabel={label(`offer.${capability.family}`)}
                      checked={draft.families.includes(capability.family)}
                      disabled={!capability.available}
                      onCheckedChange={(enabled) =>
                        setDraft({
                          ...draft,
                          families: toggle(draft.families, capability.family, enabled),
                        })
                      }
                    />
                  }
                />
              ))}
            </GroupedSection>
            <Text>{label('limits')}</Text>
            <Field label={label('minimum')}>
              <TextFieldInput
                label={label('minimum')}
                accessibilityLabel={label('minimum')}
                placeholder={label('minimum')}
                value={minimum}
                onChangeText={setMinimum}
                keyboardType="decimal-pad"
              />
            </Field>
            <Field label={label('maximum')}>
              <TextFieldInput
                label={label('maximum')}
                accessibilityLabel={label('maximum')}
                placeholder={label('maximum')}
                value={maximum}
                onChangeText={setMaximum}
                keyboardType="decimal-pad"
              />
            </Field>
            {!valid && <Text accessibilityRole="alert">{label('invalidLimits')}</Text>}
            <GroupedSection title={label('countries')}>
              {['US', 'CA'].map((country) => (
                <GroupedSectionItem
                  key={country}
                  title={label(country)}
                  rightElement={
                    <Switch
                      accessibilityLabel={label(`allow.${country}`)}
                      checked={draft.countries.includes(country)}
                      onCheckedChange={(enabled) =>
                        setDraft({ ...draft, countries: toggle(draft.countries, country, enabled) })
                      }
                    />
                  }
                />
              ))}
            </GroupedSection>
            <GroupedSection title={label('currencies')}>
              {['USD', 'EUR'].map((currency) => (
                <GroupedSectionItem
                  key={currency}
                  title={currency}
                  description={currency === 'EUR' ? label('providerUnavailable') : undefined}
                  rightElement={
                    <Switch
                      accessibilityLabel={label(`allow.${currency}`)}
                      checked={draft.currencies.includes(currency)}
                      disabled={currency === 'EUR'}
                      onCheckedChange={(enabled) =>
                        setDraft({
                          ...draft,
                          currencies: toggle(draft.currencies, currency, enabled),
                        })
                      }
                    />
                  }
                />
              ))}
            </GroupedSection>
            <GroupedSection title={label('purchaseKinds')} footer={label('capabilityPerPlan')}>
              {(['one_time', 'subscription'] as const).map((kind) => (
                <GroupedSectionItem
                  key={kind}
                  title={label(kind)}
                  rightElement={
                    <Switch
                      accessibilityLabel={label(`allow.${kind}`)}
                      checked={draft.purchaseKinds.includes(kind)}
                      onCheckedChange={(enabled) =>
                        setDraft({
                          ...draft,
                          purchaseKinds: toggle(draft.purchaseKinds, kind, enabled),
                        })
                      }
                    />
                  }
                />
              ))}
            </GroupedSection>
            <Field label={label('message')}>
              <TextFieldInput
                label={label('message')}
                accessibilityLabel={label('message')}
                placeholder={label('message')}
                value={draft.message}
                maxLength={160}
                onChangeText={(message) => setDraft({ ...draft, message })}
              />
            </Field>
            <Field label={label('terms')}>
              <TextFieldInput
                label={label('terms')}
                accessibilityLabel={label('terms')}
                placeholder={label('terms')}
                value={draft.terms}
                maxLength={2000}
                multiline
                onChangeText={(terms) => setDraft({ ...draft, terms })}
              />
            </Field>
            <Text>{label('termsBoundary')}</Text>
            <Button
              size="lg"
              disabled={!valid}
              onPress={() => {
                onChange(next);
                setOpen(false);
              }}
            >
              {label('save')}
            </Button>
          </View>
        </Dialog>
      )}
    </>
  );
}
