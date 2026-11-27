import type React from 'react';
import { useState } from 'react';
import { ScrollView, type ViewStyle } from 'react-native';
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
  defineModifier,
  defineTokens,
  toElement,
  VStack as LVStack,
  toElement as LtoElement,
  Embed as LEmbed,
  TextEditor,
} from '@oxy.so/bloom-language';

const appColors = defineTokens({ color: { hexFFFFFF: '#FFFFFF' } });

/** The close button: an 8pt target pad, above the centred title. */
const CLOSE_STYLE: ViewStyle = { padding: 8, zIndex: 10 };
const CONTENT_STYLE: ViewStyle = { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 };
/** Cancel and Submit: halves of the row, centred, at least 50pt tall. */
const reportTokens = defineTokens({ space: { actionMinHeight: 50 } });
const actionButton = defineModifier((v) =>
  v.padding('vertical', '14').frame({ minHeight: reportTokens.space.actionMinHeight }).flex('1'),
);

interface ReportModalProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (categories: string[], details?: string) => void;
}

export const ReportModal: React.FC<ReportModalProps> = ({ visible, onClose, onSubmit }) => {
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
    Embed((render) =>
      LtoElement(
        LVStack(
          /* Header */ LEmbed(
            render(
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
            ),
          ),
          LEmbed(render(LDivider())),
          /* Content */ LEmbed(
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
                    // A category: 14pt by 16pt inside a 1.5pt outline, 12pt corners.
                    return (
                      VStack(
                        LCheckbox([isSelected, () => toggleCategory(category.id)], category.label),
                      )
                        .padding('vertical', '14')
                        .padding('horizontal', 'lg')
                        // The selected tint is the primary at 10% (`withAlpha`), never
                        // `theme.colors.primary + '20'`: the token is an `rgb(...)` string,
                        // so a hex-alpha suffix makes a malformed colour react-native-web
                        // reads as fully opaque primary — a solid card behind the label.
                        .background(isSelected ? 'primary/10' : 'card')
                        .border(isSelected ? 'primary' : 'border', '1.5')
                        .corner('md')
                        .id(category.id)
                    );
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
                    LtoElement(
                      TextEditor([details, setDetails])
                        .placeholder(t('report.contextPlaceholder'))
                        .rows(5)
                        .autoResize(7)
                        .maxLength(500)
                        .showCount(),
                    ),
                  ),
                ).margin('bottom', 'lg'),
              )}
            </ScrollView>,
          ),
          /* Action Buttons */ LEmbed(render(LDivider())),
          LEmbed(
            render(
              HStack(
                VStack(
                  RawText('Cancel')
                    .foreground('foreground')
                    .font('16')
                    .leading('normal')
                    .weight('semibold'),
                )
                  .align('center')
                  .justify('center')
                  .modifier(actionButton)
                  .background('card')
                  .border('border', 'thin')
                  .corner('md')
                  .role('button')
                  .onPress(handleCancel)
                  .pressFade('70'),
                VStack(
                  RawText('Submit Report')
                    .font('16')
                    .leading('normal')
                    .weight('semibold')
                    .foreground(canSubmit ? appColors.color.hexFFFFFF : 'muted'),
                )
                  .align('center')
                  .justify('center')
                  .modifier(actionButton)
                  .background(canSubmit ? 'error' : 'border')
                  .corner('md')
                  .role('button')
                  .accessibilityState({ disabled: !canSubmit })
                  .disabled(!canSubmit)
                  .onPress(handleSubmit)
                  .pressFade('70'),
              )
                .spacing('md')
                .padding('horizontal', 'lg')
                .padding('top', 'lg')
                // `py-4 pb-5`: the web's CSS kept py-4's bottom, NativeWind took pb-5's.
                .padding('bottom', 'lg')
                .when('native', (v) => v.padding('bottom', 'xl')),
            ),
          ),
        )
          .frame({ maxHeight: '90%' })
          .background('background')
          .corner('2xl', 'top-left')
          .corner('2xl', 'top-right'),
      ),
    ),
  );
};

export default ReportModal;
