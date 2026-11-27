import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  INSTALLMENT_CAPABILITY_FIXTURES,
  validMerchantInstallmentPreferences,
  type MerchantInstallmentPreferences,
} from '@/lib/payments/merchantInstallmentPreview';
import { Button as LButton, Embed, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { Field as LField, TextField as LTextField, Toggle } from '@oxy.so/bloom-language/inputs';
import { Dialog as LDialog } from '@oxy.so/bloom-language/overlays';

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
      {open &&
        toElement(
          LDialog(
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
                LTextField([minimum, setMinimum], label('minimum'))
                  .placeholder(label('minimum'))
                  .keyboard('decimal-pad'),
              ),
              LField(
                label('maximum'),
                LTextField([maximum, setMaximum], label('maximum'))
                  .placeholder(label('maximum'))
                  .keyboard('decimal-pad'),
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
                LTextField(
                  [draft.message, (message) => setDraft({ ...draft, message })],
                  label('message'),
                )
                  .placeholder(label('message'))
                  .maxLength(160),
              ),
              LField(
                label('terms'),
                LTextField([draft.terms, (terms) => setDraft({ ...draft, terms })], label('terms'))
                  .placeholder(label('terms'))
                  .maxLength(2000)
                  .multiline(),
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
          )
            .presentAt('bottom')
            .detached()
            .padding('none')
            .panelFrame({ maxWidth: '540' })
            .header({ title: label('title'), showClose: true, largeTitle: false })
            .presented([true, () => setOpen(false)]),
        )}
    </>
  );
}
