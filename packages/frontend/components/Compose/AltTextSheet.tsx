import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, Image, ScrollView, TouchableOpacity } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { describeContentLanguage } from '@/constants/contentLanguages';

/** Matches the backend cap on `content.media[].alt`. */
const ALT_MAX_LENGTH = 2000;

interface AltTextSheetProps {
  /** Resolved, ready-to-render preview URL for the image being described. */
  imageUrl: string;
  /**
   * The languages this image's description can be written in, in tab order.
   * A single entry renders no selector — an image that only exists in one
   * language has nothing to switch between.
   */
  languageTags: readonly string[];
  /** Which language the sheet opens on — the tab the author came from. */
  initialTag: string;
  /** The description currently stored for a language ('' when none). */
  getAlt: (tag: string) => string;
  /** Every description the author edited, by language tag. */
  onSave: (altByTag: Record<string, string>) => void;
  onClose: () => void;
}

/**
 * Bottom-sheet alt-text editor (Bluesky-style).
 *
 * When a post carries several author languages, the SAME image needs a
 * description in each of them: a blind reader in Spanish is served the Spanish
 * body, so they must get the Spanish alt too. The selector here writes into
 * `variant.alt[mediaId]` for the shared image set — which is why the sheet edits
 * every language at once and reports them together on Done.
 *
 * An image that belongs to a language's OWN media set is passed a single tag:
 * its description lives on the image itself, not in a per-language map.
 */
const AltTextSheet: React.FC<AltTextSheetProps> = ({
  imageUrl,
  languageTags,
  initialTag,
  getAlt,
  onSave,
  onClose,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const tags = useMemo(
    () => (languageTags.includes(initialTag) ? languageTags : [initialTag, ...languageTags]),
    [languageTags, initialTag],
  );

  const [activeTag, setActiveTag] = useState(initialTag);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const tag of tags) initial[tag] = getAlt(tag);
    return initial;
  });

  const value = values[activeTag] ?? '';

  const handleChange = useCallback(
    (next: string) => setValues((prev) => ({ ...prev, [activeTag]: next })),
    [activeTag],
  );

  const handleSave = useCallback(() => {
    const trimmed: Record<string, string> = {};
    for (const [tag, alt] of Object.entries(values)) trimmed[tag] = alt.trim();
    onSave(trimmed);
    onClose();
  }, [values, onSave, onClose]);

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border mb-3">
        <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('compose.altText.heading', { defaultValue: 'Alt text' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-[13px] text-muted-foreground mb-3 px-4" style={helpTextStyle}>
          {t('compose.altText.help', {
            defaultValue:
              'Describe this image for people who are blind or have low vision, and to add context for everyone.',
          })}
        </Text>

        {imageUrl ? (
          <View className="mx-4 mb-3 rounded-[15px] overflow-hidden border border-border bg-secondary">
            <Image
              source={{ uri: imageUrl }}
              className="w-full"
              style={previewStyle}
              resizeMode="cover"
            />
          </View>
        ) : null}

        {tags.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={tabsContentStyle}
          >
            {tags.map((tag) => {
              const isActive = tag === activeTag;
              const hasAlt = (values[tag] ?? '').trim().length > 0;
              return (
                <TouchableOpacity
                  key={tag}
                  onPress={() => setActiveTag(tag)}
                  activeOpacity={0.75}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                  className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full border"
                  style={{
                    borderColor: isActive ? theme.colors.primary : theme.colors.border,
                    backgroundColor: isActive ? `${theme.colors.primary}1A` : 'transparent',
                  }}
                >
                  <Text
                    className="text-[13px] font-semibold"
                    style={{ color: isActive ? theme.colors.primary : theme.colors.textSecondary }}
                  >
                    {describeContentLanguage(tag).nativeName}
                  </Text>
                  {hasAlt ? (
                    <View
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: theme.colors.primary }}
                    />
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : null}

        <View className="mx-4 rounded-xl border-[1.5px] border-border bg-secondary px-3 py-2.5">
          <TextInput
            className="text-sm text-foreground"
            style={inputStyle}
            placeholder={t('compose.altText.placeholder', { defaultValue: 'Describe this image…' })}
            placeholderTextColor={theme.colors.textTertiary}
            value={value}
            onChangeText={handleChange}
            maxLength={ALT_MAX_LENGTH}
            multiline
            autoFocus
            autoCapitalize="sentences"
            autoCorrect
          />
        </View>
        <Text className="text-[11px] text-right text-muted-foreground mt-1.5 px-4">
          {value.length}/{ALT_MAX_LENGTH}
        </Text>
      </ScrollView>

      <TouchableOpacity
        onPress={handleSave}
        className="flex-row items-center justify-center py-3 rounded-full mt-2 mx-4"
        style={{ backgroundColor: theme.colors.primary }}
        activeOpacity={0.85}
      >
        <Text className="text-sm font-semibold" style={{ color: theme.colors.card }}>
          {t('common.done', { defaultValue: 'Done' })}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const scrollContentStyle = { paddingBottom: 24 };
const helpTextStyle = { lineHeight: 18 };
const previewStyle = { aspectRatio: 16 / 9 };
const inputStyle = { minHeight: 96, textAlignVertical: 'top' as const };
const tabsContentStyle = { gap: 8, paddingHorizontal: 16, paddingBottom: 12 };

export default AltTextSheet;
