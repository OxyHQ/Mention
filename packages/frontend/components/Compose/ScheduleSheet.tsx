import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, ScrollView, type ViewStyle } from 'react-native';
import { tokens } from '@oxy.so/bloom/styles';

import { DatePicker, TimeField } from '@oxy.so/bloom/date-picker';
import { Card } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { formatTimeInput } from '@/utils/dateUtils';
import {
  Button as LButton,
  Embed,
  HStack,
  RawText,
  Text as LText,
  VStack,
  toElement,
  Text,
  Card as LCard,
} from '@oxy.so/bloom-language';

export type ScheduleOption = {
  key: string;
  label: string;
  date: Date;
};

export interface ScheduleSheetProps {
  scheduledAt: Date | null;
  options: ScheduleOption[];
  onSelect: (date: Date) => void;
  onClear: () => void;
  onClose: () => void;
  formatLabel: (date: Date) => string;
}

/** Bloom's `DatePicker` speaks local-midnight days. */
const toLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Merges the picked day and time into one local timestamp. */
export const parseDateTime = (day: Date | null, time: string | null): Date | null => {
  if (!day || !time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  const parsed = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

const ensureFutureDate = (date: Date): boolean => {
  const now = new Date();
  return date.getTime() > now.getTime();
};

const ScheduleSheet: React.FC<ScheduleSheetProps> = ({
  scheduledAt,
  options,
  onSelect,
  onClear,
  onClose,
  formatLabel,
}) => {
  const { t } = useTranslation();

  const initialDate = useMemo(
    () => scheduledAt ?? new Date(Date.now() + 15 * 60000),
    [scheduledAt],
  );
  const [customDate, setCustomDate] = useState<Date | null>(() => toLocalDay(initialDate));
  const [customTime, setCustomTime] = useState<string | null>(() => formatTimeInput(initialDate));
  // Days before today cannot be scheduled; the time is still checked on apply.
  const [today] = useState(() => toLocalDay(new Date()));

  const handleCustomApply = useCallback(() => {
    const parsed = parseDateTime(customDate, customTime);
    if (!parsed) {
      toast(t('compose.schedule.invalidDate', { defaultValue: 'Enter a valid date and time' }), {
        type: 'error',
      });
      return;
    }

    if (!ensureFutureDate(parsed)) {
      toast(t('compose.schedule.futureRequired', { defaultValue: 'Pick a future time' }), {
        type: 'error',
      });
      return;
    }

    onSelect(parsed);
  }, [customDate, customTime, onSelect, t]);

  const handleOptionPress = useCallback(
    (option: ScheduleOption) => {
      onSelect(option.date);
    },
    [onSelect],
  );

  const handleClear = useCallback(() => {
    onClear();
  }, [onClear]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // The surface, corner radius and drag handle belong to the bottom sheet that
  // hosts this; drawing them again here stacked a second background on it.
  return toElement(
    VStack(
      Embed(
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        >
          {toElement(
            RawText(t('compose.schedule.title', { defaultValue: 'Schedule post' }))
              .font('xl')
              .leading('28px')
              .weight('semibold')
              .foreground('foreground')
              .margin('bottom', 'lg'),
          )}

          {scheduledAt && (
            <Card appearance="subtle" border="hairline" radius="radius-16" style={CURRENT_STYLE}>
              {toElement(
                VStack(
                  RawText(t('compose.schedule.current', { defaultValue: 'Currently scheduled' }))
                    .font('sm')
                    .foreground('muted')
                    .margin('bottom', 'xs'),
                  RawText(formatLabel(scheduledAt))
                    .font('16')
                    .leading('normal')
                    .weight('medium')
                    .foreground('foreground'),
                ).flex('1'),
              )}
              {toElement(
                LButton(LText(t('compose.schedule.clear', { defaultValue: 'Clear' })))
                  .style('subtle')
                  .tint('danger')
                  .size('sm')
                  .onPress(handleClear)
                  .testID('scheduleSheetClear'),
              )}
            </Card>
          )}

          {toElement(
            RawText(t('compose.schedule.quickPick', { defaultValue: 'Quick picks' }))
              .font('xs')
              .leading('16px')
              .textCase('uppercase')
              .tracking('wide')
              .foreground('muted')
              .margin('bottom', '10'),
          )}

          {toElement(
            HStack(
              Embed(
                options.map((option) =>
                  toElement(
                    LCard(
                      RawText(option.label)
                        .font('md')
                        .weight('semibold')
                        .foreground('foreground')
                        .margin('bottom', '6')
                        .textAlign('left'),
                      RawText(formatLabel(option.date))
                        .font('11')
                        .foreground('muted')
                        .textAlign('left')
                        .leading('14px'),
                    )
                      .style('outline')
                      .outline('hairline')
                      .elevation('none')
                      .radius('lg')
                      .onPress(() => handleOptionPress(option))
                      .label(`${option.label}, ${formatLabel(option.date)}`)
                      .padding('all', '10')
                      .justify('center')
                      .align('start')
                      .frame({ width: '31%' })
                      .aspectRatio(1.6),
                    option.key,
                  ),
                ),
              ),
            )
              .wrap()
              .spacing('10')
              .margin('bottom', 'xl'),
          )}

          {toElement(
            RawText(t('compose.schedule.pickCustom', { defaultValue: 'Pick custom time' }))
              .font('xs')
              .leading('16px')
              .textCase('uppercase')
              .tracking('wide')
              .foreground('muted')
              .margin('bottom', '10'),
          )}

          {toElement(
            HStack(
              Embed(
                <Field
                  label={t('compose.schedule.dateLabel', { defaultValue: 'Date' })}
                  style={styles.dateField}
                >
                  <DatePicker
                    value={customDate}
                    onChange={setCustomDate}
                    minDate={today}
                    accessibilityLabel={t('compose.schedule.dateLabel', { defaultValue: 'Date' })}
                    testID="scheduleSheetDatePicker"
                  />
                </Field>,
              ),
              Embed(
                <Field
                  label={t('compose.schedule.timeLabel', { defaultValue: 'Time' })}
                  style={styles.timeField}
                >
                  <TimeField
                    value={customTime}
                    onChange={setCustomTime}
                    testID="scheduleSheetTimeField"
                  />
                </Field>,
              ),
            )
              .margin('bottom', 'xl')
              .spacing('md'),
          )}
        </ScrollView>,
      ),
      HStack(
        LButton(Text(t('compose.schedule.cancel', { defaultValue: 'Close' })))
          .style('outline')
          .tint('neutral')
          .size('lg')
          .onPress(handleClose)
          .testID('scheduleSheetClose')
          .grow(),
        LButton(Text(t('compose.schedule.apply', { defaultValue: 'Schedule' })))
          .tint('action')
          .size('lg')
          .onPress(handleCustomApply)
          .testID('scheduleSheetApply')
          .grow(),
      )
        .padding('vertical', 'md')
        .spacing('md'),
    )
      .padding('horizontal', 'xl')
      .padding('top', 'md')
      .frame({ maxHeight: '90%' }),
  );
};

// Inline objects, not a StyleSheet: what Tailwind's classes drew here, its
// off-scale steps named once (`px-3.5`, `mb-4.5`).
const CURRENT_PADDING_X = 14;
const CURRENT_MARGIN_BOTTOM = 18;
/** The current schedule: its text and Clear in one row (`flex-row items-center py-3 px-3.5 mb-4.5`). */
const CURRENT_STYLE = {
  flexDirection: 'row',
  alignItems: 'center',
  paddingVertical: tokens.space.md,
  paddingHorizontal: CURRENT_PADDING_X,
  marginBottom: CURRENT_MARGIN_BOTTOM,
} satisfies ViewStyle;

const styles = StyleSheet.create({
  // `Field` is full-width by default, so two of them in a row fight over the same
  // 100%: the date takes the remaining space, the time keeps the width of its box.
  dateField: {
    flex: 1,
    minWidth: 0,
    width: 'auto',
  },
  timeField: {
    flexShrink: 0,
    width: 112,
  },
});

export default ScheduleSheet;
