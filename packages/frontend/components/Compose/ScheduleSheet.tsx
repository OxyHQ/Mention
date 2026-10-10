import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { DatePicker, TimeField } from '@oxy.so/bloom/date-picker';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { formatTimeInput } from '@/utils/dateUtils';

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

  const initialDate = useMemo(() => scheduledAt ?? new Date(Date.now() + 15 * 60000), [scheduledAt]);
  const [customDate, setCustomDate] = useState<Date | null>(() => toLocalDay(initialDate));
  const [customTime, setCustomTime] = useState<string | null>(() => formatTimeInput(initialDate));
  // Days before today cannot be scheduled; the time is still checked on apply.
  const [today] = useState(() => toLocalDay(new Date()));

  const handleCustomApply = useCallback(() => {
    const parsed = parseDateTime(customDate, customTime);
    if (!parsed) {
      toast(t('compose.schedule.invalidDate', { defaultValue: 'Enter a valid date and time' }), { type: 'error' });
      return;
    }

    if (!ensureFutureDate(parsed)) {
      toast(t('compose.schedule.futureRequired', { defaultValue: 'Pick a future time' }), { type: 'error' });
      return;
    }

    onSelect(parsed);
  }, [customDate, customTime, onSelect, t]);

  const handleOptionPress = useCallback((option: ScheduleOption) => {
    onSelect(option.date);
  }, [onSelect]);

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
        <Text className="text-xl font-semibold text-foreground mb-4">
          {t('compose.schedule.title', { defaultValue: 'Schedule post' })}
        </Text>

        {scheduledAt && (
          <Card
            appearance="subtle"
            border="hairline"
            radius="radius-16"
            className="flex-row items-center py-3 px-3.5 mb-4.5"
          >
            <View className="flex-1">
              <Text className="text-[13px] text-muted-foreground mb-1">
                {t('compose.schedule.current', { defaultValue: 'Currently scheduled' })}
              </Text>
              <Text className="text-base font-medium text-foreground">
                {formatLabel(scheduledAt)}
              </Text>
            </View>
            <Button appearance="subtle" tone="danger" size="sm" onPress={handleClear} testID="scheduleSheetClear">
              {t('compose.schedule.clear', { defaultValue: 'Clear' })}
            </Button>
          </Card>
        )}

        <Text className="text-xs uppercase tracking-wide text-muted-foreground mb-2.5">
          {t('compose.schedule.quickPick', { defaultValue: 'Quick picks' })}
        </Text>

        <View className="flex-row flex-wrap gap-2.5 mb-5">
          {options.map((option) => (
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
              <Text className="text-[15px] font-semibold text-foreground mb-1.5 text-left">
                {option.label}
              </Text>
              <Text className="text-[11px] text-muted-foreground text-left" style={{ lineHeight: 14 }}>
                {formatLabel(option.date)}
              </Text>
            </Card>
          ))}
        </View>

        <Text className="text-xs uppercase tracking-wide text-muted-foreground mb-2.5">
          {t('compose.schedule.pickCustom', { defaultValue: 'Pick custom time' })}
        </Text>

        <View className="flex-row mb-5 gap-3">
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
          </Field>
          <Field label={t('compose.schedule.timeLabel', { defaultValue: 'Time' })} style={styles.timeField}>
            <TimeField
              value={customTime}
              onChange={setCustomTime}
              testID="scheduleSheetTimeField"
            />
          </Field>
        </View>

      </ScrollView>

      <View className="flex-row gap-3 py-3">
        <Button
          appearance="outline"
          tone="neutral"
          size="lg"
          style={styles.footerButton}
          onPress={handleClose}
          testID="scheduleSheetClose"
        >
          {t('compose.schedule.cancel', { defaultValue: 'Close' })}
        </Button>
        <Button
          tone="action"
          size="lg"
          style={styles.footerButton}
          onPress={handleCustomApply}
          testID="scheduleSheetApply"
        >
          {t('compose.schedule.apply', { defaultValue: 'Schedule' })}
        </Button>
      </View>
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
    width: "31%",
    aspectRatio: 1.6,
    padding: 10,
    justifyContent: "center",
    alignItems: "flex-start",
  },
});

export default ScheduleSheet;
