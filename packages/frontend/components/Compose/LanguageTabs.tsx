import React, { memo, useCallback } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { describeContentLanguage } from '@/constants/contentLanguages';

interface LanguageTabsProps {
  primaryTag: string;
  variantTags: readonly string[];
  activeTag: string;
  /** Switch the whole composer — every item — to another language. */
  onSelect: (tag: string) => void;
  /** Pressing the ALREADY-ACTIVE tab: change its language, or remove it. */
  onEdit: (tag: string) => void;
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
      // The active tint is `bg-primary/10`, NOT `${theme.colors.primary}1A`:
      // this theme's `primary` is `rgb(0 98 157)`, so appending hex alpha to it
      // gives a string react-native-web reads back as FULLY OPAQUE primary —
      // primary text on a primary pill, i.e. an active tab whose language name
      // is invisible. A type-check and a jest label assertion both pass.
      className={`flex-row items-center gap-1.5 px-3 py-1.5 rounded-full border ${
        isActive ? 'bg-primary/10' : ''
      }`}
      style={{ borderColor: isActive ? theme.colors.primary : theme.colors.border }}
    >
      <Text
        className={`text-[13px] font-semibold ${isActive ? 'text-primary' : ''}`}
        style={isActive ? undefined : { color: theme.colors.textSecondary }}
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
 * The composer's language tabs — how the author moves BETWEEN the languages a
 * post already has.
 *
 * They are composer-WIDE: switching tab switches every item (the main post and
 * each thread item) to that language, which is what the (item × language) buffer
 * means in the UI. The primary tab is marked with a dot — it is the body that
 * federates, gets signed onto the chain, and that every other language inherits
 * its media and article from.
 *
 * ADDING a language is not here — it is an attachment like any other and lives
 * in the toolbar (`ComposeToolbar`'s `onLanguagePress`). Everything else stays,
 * INCLUDING the lone primary tab of a single-language post: tapping it is how
 * the author changes what language the post declares, which decides who the feed
 * serves it to and what federates. It is not the reader-side `PostLanguageChip`,
 * which correctly hides below two renditions because it only switches between
 * bodies that already exist.
 */
const LanguageTabs = memo(function LanguageTabs({
  primaryTag,
  variantTags,
  activeTag,
  onSelect,
  onEdit,
  disabled,
}: LanguageTabsProps) {
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
