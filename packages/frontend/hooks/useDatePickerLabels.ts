import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DatePickerLabels } from '@oxy.so/bloom/date-picker';

/**
 * The fixed strings of Bloom's `DatePicker` popup — the footer's Cancel / Apply
 * and the month chevrons' names — in the reader's language.
 *
 * Bloom draws these in English unless told otherwise, and they were the only
 * English left in the event editor and the schedule sheet. Month titles,
 * weekdays and the trigger's date already follow the `locale` prop; the
 * trigger's name is the caller's `accessibilityLabel`.
 *
 * The English `defaultValue`s keep a missing catalog entry from rendering the
 * KEY on a button.
 */
export function useDatePickerLabels(): DatePickerLabels {
  const { t, i18n } = useTranslation();
  const language = i18n.language;

  return useMemo(
    () => ({
      cancel: t('common.cancel', { defaultValue: 'Cancel' }),
      apply: t('datePicker.apply', { defaultValue: 'Apply' }),
      previousMonth: t('datePicker.previousMonth', { defaultValue: 'Previous month' }),
      nextMonth: t('datePicker.nextMonth', { defaultValue: 'Next month' }),
    }),
    // `language` re-runs this when the reader switches language, whether or
    // not `t` changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, language],
  );
}
