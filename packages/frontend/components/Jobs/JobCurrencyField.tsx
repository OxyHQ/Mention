import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CurrencyCode } from '@mention/shared-types';
import { CURRENCY_CODES } from '@mention/shared-types/job';
import { useJobVocabulary } from '@/utils/jobVocabulary';
import CodePickerDialog from './CodePickerDialog';

import { Embed, Row, VStack, toElement } from '@oxy.so/bloom-language';

interface JobCurrencyFieldProps {
  value: CurrencyCode;
  onChange: (next: CurrencyCode) => void;
}

/** A salary currency, picked from `CURRENCY_CODES` — the list Clarity validates against. */
const JobCurrencyField = memo(function JobCurrencyField({
  value,
  onChange,
}: JobCurrencyFieldProps) {
  const { t } = useTranslation();
  const vocabulary = useJobVocabulary();
  const [open, setOpen] = useState(false);

  const options = useMemo(
    () => CURRENCY_CODES.map((code) => ({ code, name: vocabulary.currencyName(code) })),
    [vocabulary],
  );
  const name = vocabulary.currencyName(value);
  const title = t('jobs.create.currency', { defaultValue: 'Currency' });

  return toElement(
    VStack(
      Row(name ? `${value} · ${name}` : value)
        .onPress(() => setOpen(true))
        .subtitle(title),
      Embed(
        <CodePickerDialog
          open={open}
          title={t('jobs.create.selectCurrency', { defaultValue: 'Choose a currency' })}
          searchLabel={t('jobs.create.currencySearchLabel', { defaultValue: 'Search currencies' })}
          options={options}
          selected={value}
          onSelect={(code) => {
            onChange(code);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />,
      ),
    )
      .background('card')
      .border('border', 'thin')
      .corner('14')
      .clipped(),
  );
});

export default JobCurrencyField;
