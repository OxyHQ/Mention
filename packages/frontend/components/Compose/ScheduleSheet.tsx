import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { DatePicker, TimeField } from '@oxy.so/bloom/date-picker';
import { Button } from '@oxy.so/bloom/button';
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

  return (
    // The surface, corner radius and drag handle belong to the bottom sheet that
    // hosts this; drawing them again here stacked a second background on it.
    <View className="px-5 pt-3" style={{ maxHeight: '90%' }}>
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
          <Card
            appearance="subtle"
            border="hairline"
            radius="radius-16"
            className="flex-row items-center py-3 px-3.5 mb-4.5"
          >
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
              options.map((option) => (
                <Card
                  key={option.key}
                  appearance="outline"
                  border="hairline"
                  elevation="none"
                  radius="radius-16"
                  style={styles.optionButton}
                  onPress={() => handleOptionPress(option)}
                  accessibilityLabel={`${option.label}, ${formatLabel(option.date)}`}
                >
                  {toElement(
                    RawText(option.label)
                      .font('md')
                      .weight('semibold')
                      .foreground('foreground')
                      .margin('bottom', '6')
                      .textAlign('left'),
                  )}
                  <Text
                    className="text-[11px] text-muted-foreground text-left"
                    style={{ lineHeight: 14 }}
                  >
                    {formatLabel(option.date)}
                  </Text>
                </Card>
              )),
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
      </ScrollView>
      {toElement(
        HStack(
          Embed(
            <Button
              appearance="outline"
              tone="neutral"
              size="lg"
              style={styles.footerButton}
              onPress={handleClose}
              testID="scheduleSheetClose"
            >
              {t('compose.schedule.cancel', { defaultValue: 'Close' })}
            </Button>,
          ),
          Embed(
            <Button
              tone="action"
              size="lg"
              style={styles.footerButton}
              onPress={handleCustomApply}
              testID="scheduleSheetApply"
            >
              {t('compose.schedule.apply', { defaultValue: 'Schedule' })}
            </Button>,
          ),
        )
          .padding('vertical', 'md')
          .spacing('md'),
      )}
    </View>
  );
};

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
  footerButton: {
    flex: 1,
  },
  optionButton: {
    width: '31%',
    aspectRatio: 1.6,
    padding: 10,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
});

export default ScheduleSheet;
