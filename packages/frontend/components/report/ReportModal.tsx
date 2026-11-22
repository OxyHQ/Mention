import type React from 'react';
import { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Field } from '@oxy.so/bloom/field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { REPORT_CATEGORIES } from '@/services/reportService';

import {
  Checkbox as LCheckbox,
  Divider as LDivider,
  Embed,
  HStack,
  Icon,
  RawText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface ReportModalProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (categories: string[], details?: string) => void;
}

export const ReportModal: React.FC<ReportModalProps> = ({ visible, onClose, onSubmit }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [details, setDetails] = useState('');

  if (!visible) return null;

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories((prev) =>
      prev.includes(categoryId) ? prev.filter((id) => id !== categoryId) : [...prev, categoryId],
    );
  };

  const handleSubmit = () => {
    if (selectedCategories.length === 0) {
      return;
    }
    onSubmit(selectedCategories, details || undefined);
    setSelectedCategories([]);
    setDetails('');
    onClose();
  };

  const handleCancel = () => {
    setSelectedCategories([]);
    setDetails('');
    onClose();
  };

  return (
    <View className="bg-background rounded-t-3xl" style={{ maxHeight: '90%' }}>
      {/* Header */}
      {toElement(
        HStack(
          Embed(
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
              onPress={handleCancel}
              className="p-2 z-10"
              activeOpacity={0.7}
            >
              {toElement(Icon(RiCloseLine).size('md').foreground('foreground'))}
            </TouchableOpacity>,
          ),
          Embed(
            <Text
              className="text-foreground text-lg font-bold absolute left-0 right-0 text-center"
              style={{ pointerEvents: 'none' }}
            >
              Report Post
            </Text>,
          ),
          Embed(<View style={{ width: 36, marginLeft: 'auto' }} />),
        )
          .padding('horizontal', 'lg')
          .padding('vertical', 'md')
          .frame({ minHeight: '56' })
          .align('center'),
      )}
      {toElement(LDivider())}
      {/* Content */}
      <ScrollView className="px-4 pt-4 pb-2">
        <Text className="text-muted-foreground text-[15px] mb-4" style={{ lineHeight: 20 }}>
          Select at least one reason for reporting:
        </Text>

        {/* Categories */}
        {toElement(
          VStack(
            Embed(
              REPORT_CATEGORIES.map((category) => {
                const isSelected = selectedCategories.includes(category.id);
                return (
                  // The selected tint is `bg-primary/10`, never
                  // `theme.colors.primary + '20'`: the token is an
                  // `rgb(...)` string, so a hex-alpha suffix makes a
                  // malformed colour react-native-web reads as fully
                  // opaque primary — a solid card behind the label.
                  <View
                    key={category.id}
                    className={`py-3.5 px-4 rounded-xl ${isSelected ? 'bg-primary/10' : 'bg-card'}`}
                    style={{
                      borderColor: isSelected ? theme.colors.primary : theme.colors.border,
                      borderWidth: 1.5,
                    }}
                  >
                    {toElement(
                      LCheckbox([isSelected, () => toggleCategory(category.id)], category.label),
                    )}
                  </View>
                );
              }),
            ),
          )
            .spacing('sm')
            .margin('bottom', '2xl'),
        )}

        {/* Details Input */}
        <Field label="Additional details (optional)" style={{ marginBottom: 16 }}>
          <Textarea
            placeholder={t('report.contextPlaceholder')}
            value={details}
            onChangeText={setDetails}
            rows={5}
            autoResize
            maxRows={7}
            maxLength={500}
            showCount
          />
        </Field>
      </ScrollView>
      {/* Action Buttons */}
      {toElement(LDivider())}
      <View className="flex-row gap-3 px-4 py-4 pb-5">
        <TouchableOpacity
          className="flex-1 items-center justify-center rounded-xl border border-border bg-card"
          style={{ paddingVertical: 14, minHeight: 50 }}
          accessibilityRole="button"
          onPress={handleCancel}
          activeOpacity={0.7}
        >
          {toElement(
            RawText('Cancel')
              .foreground('foreground')
              .font('16')
              .leading('normal')
              .weight('semibold'),
          )}
        </TouchableOpacity>

        <TouchableOpacity
          className="flex-1 items-center justify-center rounded-xl"
          style={{
            paddingVertical: 14,
            minHeight: 50,
            backgroundColor:
              selectedCategories.length > 0 ? theme.colors.error : theme.colors.border,
          }}
          accessibilityRole="button"
          accessibilityState={{ disabled: selectedCategories.length === 0 }}
          onPress={handleSubmit}
          disabled={selectedCategories.length === 0}
          activeOpacity={0.7}
        >
          <Text
            className="text-base font-semibold"
            style={{
              color: selectedCategories.length > 0 ? '#FFFFFF' : theme.colors.textSecondary,
            }}
          >
            Submit Report
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default ReportModal;
