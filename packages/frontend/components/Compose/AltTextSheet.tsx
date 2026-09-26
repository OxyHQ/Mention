import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Image, ScrollView, TouchableOpacity } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
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
      <PageHeader
        title={t('compose.altText.heading', { defaultValue: 'Alt text' })}
        titleAlign="center"
        safeArea={false}
        leading={
          <Button
            appearance="subtle" tone="neutral"
            iconOnly
            leadingIcon={RiCloseLine}
            onPress={onClose}
            accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
          />
        }
      />

      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-[13px] text-muted-foreground mt-3 mb-3 px-4" style={helpTextStyle}>
          {t('compose.altText.help', {
            defaultValue:
              'Describe this image for people who are blind or have low vision, and to add context for everyone.',
          })}
        </Text>

        {imageUrl ? (
          <Card appearance="outline" elevation="none" radius="radius-16" className="mx-4 mb-3">
            <Image
              source={{ uri: imageUrl }}
              className="w-full"
              style={previewStyle}
              resizeMode="cover"
            />
          </Card>
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
                  // `bg-primary/10`, not `${theme.colors.primary}1A`. Bloom
                  // resolves ACCENT tokens to `rgb(0 98 157)` (the tonal engine
                  // derives them; only the STATUS_COLORS family stays hex), so
                  // appending hex alpha yields a malformed colour that
                  // react-native-web renders as the OPAQUE token — measured here
                  // at contrast 1.00, primary text on primary, the language name
                  // fully invisible.
                  className={`flex-row items-center gap-1.5 px-3 py-1.5 rounded-full border ${
                    isActive ? 'bg-primary/10' : ''
                  }`}
                  style={{ borderColor: isActive ? theme.colors.primary : theme.colors.border }}
                >
                  <Text
                    className={`text-[13px] font-semibold ${isActive ? 'text-primary' : ''}`}
                    style={isActive ? undefined : { color: theme.colors.textSecondary }}
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

        <Textarea
          accessibilityLabel={t('compose.altText.heading', { defaultValue: 'Alt text' })}
          placeholder={t('compose.altText.placeholder', { defaultValue: 'Describe this image…' })}
          value={value}
          onChangeText={handleChange}
          maxLength={ALT_MAX_LENGTH}
          showCount
          rows={5}
          autoResize
          maxRows={12}
          autoFocus
          autoCapitalize="sentences"
          autoCorrect
          style={textareaStyle}
        />
      </ScrollView>

      <Button className="mt-2 mx-4" size="large" onPress={handleSave}>
        {t('common.done', { defaultValue: 'Done' })}
      </Button>
    </View>
  );
};

const scrollContentStyle = { paddingBottom: 24 };
const helpTextStyle = { lineHeight: 18 };
const previewStyle = { aspectRatio: 16 / 9 };
const textareaStyle = { marginHorizontal: 16 };
const tabsContentStyle = { gap: 8, paddingHorizontal: 16, paddingBottom: 12 };

export default AltTextSheet;
