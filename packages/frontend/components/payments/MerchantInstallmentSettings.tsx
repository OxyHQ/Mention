import { useState } from 'react';
import { Dialog } from '@oxy.so/bloom/dialog';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTranslation } from 'react-i18next';
import {
  INSTALLMENT_CAPABILITY_FIXTURES,
  validMerchantInstallmentPreferences,
  type MerchantInstallmentPreferences,
} from '@/lib/payments/merchantInstallmentPreview';

import {
  Button as LButton,
  Embed,
  Field as LField,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  Text as LText,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
      {toElement(
        LButton(LText(label('open')))
          .style('outline')
          .onPress(() => {
            setDraft(value);
            setMinimum((value.minMinorUnits / 100).toFixed(2));
            setMaximum((value.maxMinorUnits / 100).toFixed(2));
            setOpen(true);
          }),
      )}
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
          {toElement(
            VStack(
              LGroupedSection(
                LGroupedSectionItem(label('enabled')).trailing(
                  Toggle([draft.enabled, (enabled) => setDraft({ ...draft, enabled })]).label(
                    label('enabled'),
                  ),
                ),
              ).caption(label('providerBoundary')),
              LGroupedSection(
                Embed(
                  INSTALLMENT_CAPABILITY_FIXTURES.map((capability) =>
                    toElement(
                      (capability.available
                        ? LGroupedSectionItem(label(capability.family))
                        : LGroupedSectionItem(label(capability.family)).description(
                            label('providerUnavailable'),
                          )
                      ).trailing(
                        Toggle([
                          draft.families.includes(capability.family),
                          (enabled) =>
                            setDraft({
                              ...draft,
                              families: toggle(draft.families, capability.family, enabled),
                            }),
                        ])
                          .label(label(`offer.${capability.family}`))
                          .disabled(!capability.available),
                      ),
                      capability.id,
                    ),
                  ),
                ),
              ).title(label('families')),
              LText(label('limits')),
              LField(
                label('minimum'),
                Embed(
                  <TextFieldInput
                    label={label('minimum')}
                    accessibilityLabel={label('minimum')}
                    placeholder={label('minimum')}
                    value={minimum}
                    onChangeText={setMinimum}
                    keyboardType="decimal-pad"
                  />,
                ),
              ),
              LField(
                label('maximum'),
                Embed(
                  <TextFieldInput
                    label={label('maximum')}
                    accessibilityLabel={label('maximum')}
                    placeholder={label('maximum')}
                    value={maximum}
                    onChangeText={setMaximum}
                    keyboardType="decimal-pad"
                  />,
                ),
              ),
              !valid ? LText(label('invalidLimits')).role('alert') : null,
              LGroupedSection(
                Embed(
                  ['US', 'CA'].map((country) =>
                    toElement(
                      LGroupedSectionItem(label(country)).trailing(
                        Toggle([
                          draft.countries.includes(country),
                          (enabled) =>
                            setDraft({
                              ...draft,
                              countries: toggle(draft.countries, country, enabled),
                            }),
                        ]).label(label(`allow.${country}`)),
                      ),
                      country,
                    ),
                  ),
                ),
              ).title(label('countries')),
              LGroupedSection(
                Embed(
                  ['USD', 'EUR'].map((currency) =>
                    toElement(
                      (currency === 'EUR'
                        ? LGroupedSectionItem(currency).description(label('providerUnavailable'))
                        : LGroupedSectionItem(currency)
                      ).trailing(
                        Toggle([
                          draft.currencies.includes(currency),
                          (enabled) =>
                            setDraft({
                              ...draft,
                              currencies: toggle(draft.currencies, currency, enabled),
                            }),
                        ])
                          .label(label(`allow.${currency}`))
                          .disabled(currency === 'EUR'),
                      ),
                      currency,
                    ),
                  ),
                ),
              ).title(label('currencies')),
              LGroupedSection(
                Embed(
                  (['one_time', 'subscription'] as const).map((kind) =>
                    toElement(
                      LGroupedSectionItem(label(kind)).trailing(
                        Toggle([
                          draft.purchaseKinds.includes(kind),
                          (enabled) =>
                            setDraft({
                              ...draft,
                              purchaseKinds: toggle(draft.purchaseKinds, kind, enabled),
                            }),
                        ]).label(label(`allow.${kind}`)),
                      ),
                      kind,
                    ),
                  ),
                ),
              )
                .title(label('purchaseKinds'))
                .caption(label('capabilityPerPlan')),
              LField(
                label('message'),
                Embed(
                  <TextFieldInput
                    label={label('message')}
                    accessibilityLabel={label('message')}
                    placeholder={label('message')}
                    value={draft.message}
                    maxLength={160}
                    onChangeText={(message) => setDraft({ ...draft, message })}
                  />,
                ),
              ),
              LField(
                label('terms'),
                Embed(
                  <TextFieldInput
                    label={label('terms')}
                    accessibilityLabel={label('terms')}
                    placeholder={label('terms')}
                    value={draft.terms}
                    maxLength={2000}
                    multiline
                    onChangeText={(terms) => setDraft({ ...draft, terms })}
                  />,
                ),
              ),
              LText(label('termsBoundary')),
              LButton(LText(label('save')))
                .size('lg')
                .disabled(!valid)
                .onPress(() => {
                  onChange(next);
                  setOpen(false);
                }),
            )
              .padding('horizontal', 'xl')
              .padding('bottom', 'xl')
              .spacing('lg'),
          )}
        </Dialog>
      )}
    </>
  );
}
