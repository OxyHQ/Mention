import type React from 'react';
import { useState } from 'react';
import { ScrollView, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTheme, withAlpha } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { REPORT_CATEGORIES } from '@/services/reportService';

import {
  Checkbox as LCheckbox,
  Divider as LDivider,
  Embed,
  Field as LField,
  HStack,
  Icon,
  RawText,
  VStack,
  defineTokens,
  toElement,
  VStack as LVStack,
  toElement as LtoElement,
  Embed as LEmbed,
} from '@oxy.so/bloom-language';

const appColors = defineTokens({ color: { hexFFFFFF: '#FFFFFF' } });

// What the sheet's classes drew, as plain objects (inline, as the classes were).
/** The sheet: the background colour, its top corners rounded 24pt, at most 90% of the window. */
const SHEET_STYLE: ViewStyle = {
  maxHeight: '90%',
  borderTopLeftRadius: 24,
  borderTopRightRadius: 24,
};
/** The close button: an 8pt target pad, above the centred title. */
const CLOSE_STYLE: ViewStyle = { padding: 8, zIndex: 10 };
const CONTENT_STYLE: ViewStyle = { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 };
/** A category: 14pt by 16pt inside a 1.5pt outline, 12pt corners. */
const CATEGORY_STYLE: ViewStyle = {
  paddingVertical: 14,
  paddingHorizontal: 16,
  borderRadius: 12,
  borderWidth: 1.5,
};
/** Cancel and Submit: halves of the row, centred, 12pt corners. */
const ACTION_STYLE: ViewStyle = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: '0%',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 12,
  paddingVertical: 14,
  minHeight: 50,
};

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

  const canSubmit = selectedCategories.length > 0;

  return toElement(
    Embed((render) => (
      <View style={[SHEET_STYLE, { backgroundColor: theme.colors.background }]}>
        {/* Header */}
        {render(
          HStack(
            Embed(
              LtoElement(
                LVStack(LEmbed(render(Icon(RiCloseLine).size('md').foreground('foreground'))))
                  .padding('all', 'sm')
                  .zIndex('floating')
                  .role('button')
                  .label(t('common.close', { defaultValue: 'Close' }))
                  .onPress(handleCancel)
                  .pressFade('70'),
              ),
            ),
            RawText('Report Post')
              .foreground('foreground')
              .font('18')
              .leading('28px')
              .weight('bold')
              .position({ left: 'none', right: 'none' })
              .textAlign('center')
              .allowsHitTesting(false),
            Embed(LtoElement(LVStack().frame({ width: '36' }).margin('left', 'auto'))),
          )
            .padding('horizontal', 'lg')
            .padding('vertical', 'md')
            .frame({ minHeight: '56' })
            .align('center'),
        )}
        {render(LDivider())}
        {/* Content */}
        <ScrollView style={CONTENT_STYLE}>
          {render(
            RawText('Select at least one reason for reporting:')
              .foreground('muted')
              .font('md')
              .leading('20px')
              .margin('bottom', 'lg'),
          )}

          {/* Categories */}
          {render(
            VStack(
              REPORT_CATEGORIES.map((category) => {
                const isSelected = selectedCategories.includes(category.id);
                return Embed(
                  // The selected tint is the primary at 10% (`withAlpha`), never
                  // `theme.colors.primary + '20'`: the token is an `rgb(...)` string,
                  // so a hex-alpha suffix makes a malformed colour react-native-web
                  // reads as fully opaque primary — a solid card behind the label.
                  <View
                    style={[
                      CATEGORY_STYLE,
                      {
                        backgroundColor: isSelected
                          ? withAlpha(theme.colors.primary, 0.1)
                          : theme.colors.card,
                        borderColor: isSelected ? theme.colors.primary : theme.colors.border,
                      },
                    ]}
                  >
                    {render(
                      LCheckbox([isSelected, () => toggleCategory(category.id)], category.label),
                    )}
                  </View>,
                ).id(category.id);
              }),
            )
              .spacing('sm')
              .margin('bottom', '2xl'),
          )}

          {/* Details Input */}
          {toElement(
            LField(
              'Additional details (optional)',
              Embed(
                <Textarea
                  placeholder={t('report.contextPlaceholder')}
                  value={details}
                  onChangeText={setDetails}
                  rows={5}
                  autoResize
                  maxRows={7}
                  maxLength={500}
                  showCount
                />,
              ),
            ).margin('bottom', 'lg'),
          )}
        </ScrollView>
        {/* Action Buttons */}
        {render(LDivider())}
        {render(
          HStack(
            Embed(
              <TouchableOpacity
                style={[
                  ACTION_STYLE,
                  {
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.card,
                  },
                ]}
                accessibilityRole="button"
                onPress={handleCancel}
                activeOpacity={0.7}
              >
                {render(
                  RawText('Cancel')
                    .foreground('foreground')
                    .font('16')
                    .leading('normal')
                    .weight('semibold'),
                )}
              </TouchableOpacity>,
            ),
            Embed(
              <TouchableOpacity
                style={[
                  ACTION_STYLE,
                  { backgroundColor: canSubmit ? theme.colors.error : theme.colors.border },
                ]}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSubmit }}
                onPress={handleSubmit}
                disabled={!canSubmit}
                activeOpacity={0.7}
              >
                {render(
                  RawText('Submit Report')
                    .font('16')
                    .leading('normal')
                    .weight('semibold')
                    .foreground(canSubmit ? appColors.color.hexFFFFFF : 'muted'),
                )}
              </TouchableOpacity>,
            ),
          )
            .spacing('md')
            .padding('horizontal', 'lg')
            .padding('top', 'lg')
            // `py-4 pb-5`: the web's CSS kept py-4's bottom, NativeWind took pb-5's.
            .padding('bottom', 'lg')
            .when('native', (v) => v.padding('bottom', 'xl')),
        )}
      </View>
    )),
  );
};

export default ReportModal;
