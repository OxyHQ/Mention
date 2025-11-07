import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, TextInput, Platform, ScrollView } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
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
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}> 
      <View style={styles.grabberContainer}>
        <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {t('compose.schedule.title', { defaultValue: 'Schedule post' })}
        </Text>

        {scheduledAt && (
          <View style={[styles.currentRow, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}> 
            <View style={{ flex: 1 }}>
              <Text style={[styles.currentLabel, { color: theme.colors.textSecondary }]}>
                {t('compose.schedule.current', { defaultValue: 'Currently scheduled' })}
              </Text>
              <Text style={[styles.currentValue, { color: theme.colors.text }]}>
                {formatLabel(scheduledAt)}
              </Text>
            </View>
            <TouchableOpacity onPress={handleClear} style={styles.clearButton}>
              <Text style={[styles.clearText, { color: theme.colors.danger }]}> 
                {t('compose.schedule.clear', { defaultValue: 'Clear' })}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
          {t('compose.schedule.quickPick', { defaultValue: 'Quick picks' })}
        </Text>

        <View style={styles.optionsGrid}>
          {options.map((option, index) => (
            <TouchableOpacity
              key={option.key}
              style={[
                styles.optionButton,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.card,
                  marginBottom: index === options.length - 1 ? 0 : 12,
                },
              ]}
              onPress={() => handleOptionPress(option)}
              activeOpacity={0.8}
            >
              <Text style={[styles.optionLabel, { color: theme.colors.text }]}>
                {option.label}
              </Text>
              <Text style={[styles.optionDescription, { color: theme.colors.textSecondary }]}>
                {formatLabel(option.date)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
          {t('compose.schedule.pickCustom', { defaultValue: 'Pick custom time' })}
        </Text>

        <View style={styles.inputsRow}>
          <View style={[styles.inputGroup, styles.inputGroupLeft]}>
            <Text style={[styles.inputLabel, { color: theme.colors.textSecondary }]}>
              {t('compose.schedule.dateLabel', { defaultValue: 'Date' })}
            </Text>
            <TextInput
              value={customDate}
              onChangeText={setCustomDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={theme.colors.textTertiary}
              style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
              keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
              autoCorrect={false}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={[styles.inputLabel, { color: theme.colors.textSecondary }]}>
              {t('compose.schedule.timeLabel', { defaultValue: 'Time' })}
            </Text>
            <TextInput
              value={customTime}
              onChangeText={setCustomTime}
              placeholder="HH:MM"
              placeholderTextColor={theme.colors.textTertiary}
              style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
              keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
              autoCorrect={false}
            />
          </View>
        </View>

        <TouchableOpacity
          style={[styles.applyButton, { backgroundColor: theme.colors.primary }]}
          onPress={handleCustomApply}
          activeOpacity={0.85}
        >
          <Text style={styles.applyButtonText}>
            {t('compose.schedule.apply', { defaultValue: 'Schedule' })}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
        <Text style={[styles.closeText, { color: theme.colors.textSecondary }]}>
          {t('compose.schedule.cancel', { defaultValue: 'Close' })}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    maxHeight: '90%',
  },
  grabberContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 999,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 16,
  },
  currentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  currentLabel: {
    fontSize: 13,
    marginBottom: 4,
  },
  currentValue: {
    fontSize: 16,
    fontWeight: '500',
  },
  clearButton: {
    marginLeft: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  clearText: {
    fontSize: 14,
    fontWeight: '600',
  },
  sectionLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  optionsGrid: {
    flexDirection: 'column',
    marginBottom: 20,
  },
  optionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  optionDescription: {
    fontSize: 13,
  },
  inputsRow: {
    flexDirection: 'row',
    marginBottom: 20,
  },
  inputGroup: {
    flex: 1,
  },
  inputGroupLeft: {
    marginRight: 12,
  },
  inputLabel: {
    fontSize: 13,
    marginBottom: 6,
  },
  input: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: Platform.select({ ios: 12, android: 8 }) ?? 10,
    fontSize: 16,
  },
  applyButton: {
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  applyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  closeButton: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  closeText: {
    fontSize: 15,
    fontWeight: '500',
  },
});

export default ScheduleSheet;
