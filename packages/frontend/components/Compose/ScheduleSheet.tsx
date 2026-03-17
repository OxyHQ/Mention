import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, TextInput, Platform, ScrollView } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export type ScheduleOption = {
  key: string;
  label: string;
  date: Date;
};

interface ScheduleSheetProps {
  scheduledAt: Date | null;
  options: ScheduleOption[];
  onSelect: (date: Date) => void;
  onClear: () => void;
  onClose: () => void;
  formatLabel: (date: Date) => string;
}

const formatDateInput = (date: Date) => {
  try {
    return date.toISOString().slice(0, 10);
  } catch {
    return '';
  }
};

const formatTimeInput = (date: Date) => {
  try {
    return date.toISOString().slice(11, 16);
  } catch {
    return '';
  }
};

const parseDateTime = (dateStr: string, timeStr: string): Date | null => {
  if (!dateStr || !timeStr) return null;
  const isoString = `${dateStr}T${timeStr}:00`;
  const parsed = new Date(isoString);
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
  const { t } = useTranslation();

  const initialDate = useMemo(() => scheduledAt ?? new Date(Date.now() + 15 * 60000), [scheduledAt]);
  const [customDate, setCustomDate] = useState(() => formatDateInput(initialDate));
  const [customTime, setCustomTime] = useState(() => formatTimeInput(initialDate));

  const handleCustomApply = useCallback(() => {
    const parsed = parseDateTime(customDate, customTime);
    if (!parsed) {
      toast.error(t('compose.schedule.invalidDate', { defaultValue: 'Enter a valid date and time' }));
      return;
    }

    if (!ensureFutureDate(parsed)) {
      toast.error(t('compose.schedule.futureRequired', { defaultValue: 'Pick a future time' }));
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
          <View className="flex-row items-center rounded-[14px] py-3 px-3.5 mb-4.5 bg-secondary" style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border }}>
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
          </View>
        )}

        <Text className="text-xs uppercase tracking-wide text-muted-foreground mb-2.5">
          {t('compose.schedule.quickPick', { defaultValue: 'Quick picks' })}
        </Text>

        <View className="flex-row flex-wrap gap-2.5 mb-5">
          {options.map((option) => (
            <TouchableOpacity
              key={option.key}
              style={[
                styles.optionButton,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.card,
                },
              ]}
              onPress={() => handleOptionPress(option)}
              activeOpacity={0.8}
            >
              <Text className="text-[15px] font-semibold text-foreground mb-1.5 text-left">
                {option.label}
              </Text>
              <Text className="text-[11px] text-muted-foreground text-left" style={{ lineHeight: 14 }}>
                {formatLabel(option.date)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text className="text-xs uppercase tracking-wide text-muted-foreground mb-2.5">
          {t('compose.schedule.pickCustom', { defaultValue: 'Pick custom time' })}
        </Text>

        <View className="flex-row mb-5">
          <View className="flex-1 mr-3">
            <Text className="text-[13px] text-muted-foreground mb-1.5">
              {t('compose.schedule.dateLabel', { defaultValue: 'Date' })}
            </Text>
            <TextInput
              value={customDate}
              onChangeText={setCustomDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={theme.colors.textTertiary}
              className="rounded-xl text-base text-foreground bg-secondary px-3"
              style={{
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
                paddingVertical: Platform.select({ ios: 12, android: 8 }) ?? 10,
              }}
              keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
              autoCorrect={false}
            />
          </View>
          <View className="flex-1">
            <Text className="text-[13px] text-muted-foreground mb-1.5">
              {t('compose.schedule.timeLabel', { defaultValue: 'Time' })}
            </Text>
            <TextInput
              value={customTime}
              onChangeText={setCustomTime}
              placeholder="HH:MM"
              placeholderTextColor={theme.colors.textTertiary}
              className="rounded-xl text-base text-foreground bg-secondary px-3"
              style={{
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
                paddingVertical: Platform.select({ ios: 12, android: 8 }) ?? 10,
              }}
              keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
              autoCorrect={false}
            />
          </View>
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
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 10,
    justifyContent: "center",
    alignItems: "flex-start",
  },
});

export default ScheduleSheet;
