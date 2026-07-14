import React, { memo, useCallback } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Plus } from '@/assets/icons/plus-icon';
import { describeContentLanguage } from '@/constants/contentLanguages';

interface LanguageTabsProps {
  primaryTag: string;
  variantTags: readonly string[];
  activeTag: string;
  /** False once the post already carries the maximum author languages. */
  canAdd: boolean;
  /** Switch the whole composer — every item — to another language. */
  onSelect: (tag: string) => void;
  /** Pressing the ALREADY-ACTIVE tab: change its language, or remove it. */
  onEdit: (tag: string) => void;
  onAdd: () => void;
  disabled?: boolean;
}

interface LanguageTabProps {
  tag: string;
  isActive: boolean;
  isPrimary: boolean;
  onSelect: (tag: string) => void;
  onEdit: (tag: string) => void;
  disabled?: boolean;
}

const LanguageTab = memo(function LanguageTab({
  tag,
  isActive,
  isPrimary,
  onSelect,
  onEdit,
  disabled,
}: LanguageTabProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const language = describeContentLanguage(tag);

  const handlePress = useCallback(() => {
    if (isActive) {
      onEdit(tag);
    } else {
      onSelect(tag);
    }
  }, [isActive, onEdit, onSelect, tag]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.75}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={
        isPrimary
          ? t('compose.languages.primaryTabA11y', {
              defaultValue: '{{language}}, primary language',
              language: language.nativeName,
            })
          : language.nativeName
      }
      className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full border"
      style={{
        borderColor: isActive ? theme.colors.primary : theme.colors.border,
        backgroundColor: isActive ? `${theme.colors.primary}1A` : 'transparent',
      }}
    >
      <Text
        className="text-[13px] font-semibold"
        style={{ color: isActive ? theme.colors.primary : theme.colors.textSecondary }}
        numberOfLines={1}
      >
        {language.nativeName}
      </Text>
      {isPrimary ? (
        <View
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: isActive ? theme.colors.primary : theme.colors.textTertiary }}
        />
      ) : null}
    </TouchableOpacity>
  );
});

/**
 * The composer's language tabs.
 *
 * They are composer-WIDE: switching tab switches every item (the main post and
 * each thread item) to that language, which is what the (item × language) buffer
 * means in the UI. The primary tab is marked with a dot — it is the body that
 * federates, gets signed onto the chain, and that every other language inherits
 * its media and article from.
 */
const LanguageTabs = memo(function LanguageTabs({
  primaryTag,
  variantTags,
  activeTag,
  canAdd,
  onSelect,
  onEdit,
  onAdd,
  disabled,
}: LanguageTabsProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={contentContainerStyle}
    >
      <LanguageTab
        tag={primaryTag}
        isActive={activeTag === primaryTag}
        isPrimary
        onSelect={onSelect}
        onEdit={onEdit}
        disabled={disabled}
      />
      {variantTags.map((tag) => (
        <LanguageTab
          key={tag}
          tag={tag}
          isActive={activeTag === tag}
          isPrimary={false}
          onSelect={onSelect}
          onEdit={onEdit}
          disabled={disabled}
        />
      ))}
      {canAdd ? (
        <TouchableOpacity
          onPress={onAdd}
          disabled={disabled}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={t('compose.languages.add', { defaultValue: 'Add a language' })}
          className="flex-row items-center gap-1 px-3 py-1.5 rounded-full border border-dashed"
          style={{ borderColor: theme.colors.border }}
        >
          <Plus size={14} color={theme.colors.textSecondary} />
          <Text className="text-[13px] font-medium" style={{ color: theme.colors.textSecondary }}>
            {t('compose.languages.add', { defaultValue: 'Add a language' })}
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
});

const contentContainerStyle = {
  alignItems: 'center' as const,
  gap: 8,
  paddingHorizontal: 16,
  paddingVertical: 8,
};

export default LanguageTabs;
