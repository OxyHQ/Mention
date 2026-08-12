import React, { memo, useCallback } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
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
  /** Declare another language for the post. Composer-wide, like the tabs. */
  onAdd: () => void;
  /** False once the post holds the maximum author languages. */
  canAdd?: boolean;
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
 * ADDING one is here too, as the last tab. It used to sit in the first box's
 * attachment toolbar, which read as an attachment of that post — but a language
 * is not a property of any one box: the renditions are a buffer keyed by
 * (item × language), so declaring a language declares it for the main post and
 * every thread item at once. Offered from one box among several, it made that
 * box look like the one that owned the post's languages. It belongs beside the
 * languages it adds to.
 *
 * The lone primary tab of a single-language post stays, for its own reason:
 * tapping it is how the author changes what language the post DECLARES, which
 * decides who the feed serves it to and what federates. It is not the
 * reader-side translate icon, which is absent on a post already written in the
 * reader's language because translating it would do nothing.
 */
const LanguageTabs = memo(function LanguageTabs({
  primaryTag,
  variantTags,
  activeTag,
  onSelect,
  onEdit,
  onAdd,
  canAdd = true,
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
      <TouchableOpacity
        onPress={onAdd}
        disabled={disabled || !canAdd}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={t('compose.languages.add', { defaultValue: 'Add a language' })}
        className="flex-row items-center gap-1 px-3 py-1.5 rounded-full border border-dashed"
        style={{ borderColor: theme.colors.border }}
      >
        <Ionicons
          name="add"
          size={14}
          color={disabled || !canAdd ? theme.colors.textTertiary : theme.colors.textSecondary}
        />
        <Text
          className="text-[13px] font-semibold"
          style={{ color: disabled || !canAdd ? theme.colors.textTertiary : theme.colors.textSecondary }}
          numberOfLines={1}
        >
          {t('compose.languages.addShort', { defaultValue: 'Language' })}
        </Text>
      </TouchableOpacity>
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
