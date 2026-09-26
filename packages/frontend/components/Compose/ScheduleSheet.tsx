import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { DatePicker, TimeField } from '@oxy.so/bloom/date-picker';
import { Card } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';

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

/** Bloom's `TimeField` speaks local 24h `"HH:mm"`. */
const formatTimeInput = (date: Date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

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
  const theme = useTheme();
  const { t, i18n } = useTranslation();

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
    <View className="rounded-t-3xl px-5 pt-3 bg-background" style={{ maxHeight: '90%' }}>
      <View className="items-center justify-center mb-3">
        <View className="w-10 h-1 rounded-full bg-border" />
      </View>

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
            <TouchableOpacity onPress={handleClear} className="ml-3 px-3 py-1.5">
              <Text className="text-sm font-semibold" style={{ color: theme.colors.error }}>
                {t('compose.schedule.clear', { defaultValue: 'Clear' })}
              </Text>
            </TouchableOpacity>
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
            style={{ flex: 1 }}
          >
            <DatePicker
              value={customDate}
              onChange={setCustomDate}
              minDate={today}
              locale={i18n.language}
              accessibilityLabel={t('compose.schedule.dateLabel', { defaultValue: 'Date' })}
              testID="scheduleSheetDatePicker"
            />
          </Field>
          <Field label={t('compose.schedule.timeLabel', { defaultValue: 'Time' })}>
            <TimeField
              value={customTime}
              onChange={setCustomTime}
              testID="scheduleSheetTimeField"
            />
          </Field>
        </View>

        <TouchableOpacity
          className="rounded-2xl py-3.5 items-center bg-primary mb-4"
          onPress={handleCustomApply}
          activeOpacity={0.85}
        >
          <Text className="text-white text-base font-semibold">
            {t('compose.schedule.apply', { defaultValue: 'Schedule' })}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity onPress={handleClose} className="py-3.5 items-center">
        <Text className="text-[15px] font-medium text-muted-foreground">
          {t('compose.schedule.cancel', { defaultValue: 'Close' })}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  optionButton: {
    width: "31%",
    aspectRatio: 1.6,
    padding: 10,
    justifyContent: "center",
    alignItems: "flex-start",
  },
});

export default ScheduleSheet;
