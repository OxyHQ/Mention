import React, { memo, useCallback } from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import MentionTextInput from '@/components/MentionTextInput';
import PostArticlePreview from '@/components/Post/PostArticlePreview';
import { ComposeAltButton } from '@/components/Compose/ComposeAltButton';
import { VideoPreview } from '@/components/Compose/VideoPreview';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { describeContentLanguage } from '@/constants/contentLanguages';
import { MEDIA_CARD_HEIGHT, MEDIA_CARD_WIDTH, type ComposerMediaItem } from '@/utils/composeUtils';
import type { ComposeVariantItem } from '@/utils/composeVariants';
import { AVATAR_SIZE, BOTTOM_LEFT_PAD, HPAD } from './composeLayout';

interface VariantEditorProps {
  /** `MAIN_ITEM_ID` for the main post, or the thread item's id. */
  itemId: string;
  /** The language this rendition is written in. */
  tag: string;
  item: ComposeVariantItem;
  /** The primary body of THIS item, shown as the reference being translated. */
  primaryText: string;
  /** The media set this rendition shows unless it replaces it. */
  sharedMedia: readonly ComposerMediaItem[];
  /** Whether the primary item carries an article that can be localized. */
  hasArticle: boolean;
  userAvatar: string | undefined;
  userVerified: boolean;
  isFocused: boolean;
  isPosting: boolean;
  isTranslating: boolean;
  getFileDownloadUrl: (id: string) => string;
  onTextChange: (itemId: string, text: string) => void;
  onFocus: (itemId: string) => void;
  onTranslate: (itemId: string) => void;
  /** Alt for one of the SHARED images, in this language. */
  onSharedAltPress: (itemId: string, media: ComposerMediaItem) => void;
  /** Alt for one of this language's OWN images — it lives on the image itself. */
  onOwnAltPress: (itemId: string, media: ComposerMediaItem) => void;
  onPickOwnMedia: (itemId: string) => void;
  onRemoveOwnMedia: (itemId: string, mediaId: string) => void;
  onUseSharedMedia: (itemId: string) => void;
  onArticlePress: (itemId: string) => void;
  onArticleReset: (itemId: string) => void;
}

const HITSLOP_6 = { top: 6, bottom: 6, left: 6, right: 6 };

/**
 * One item (the main post, or a thread item) as seen from a NON-PRIMARY language
 * tab.
 *
 * A rendition can only override what a language actually changes: the body, the
 * descriptions of the shared images, the images themselves, and the article. The
 * poll, the location, the sources, the schedule and the reply settings belong to
 * the post, not to a language, so they are not editable here — the primary tab
 * owns them.
 *
 * Alt and own-images are two arms of a union rather than two toggles: choosing
 * this language's own images means the descriptions ride on those images, so the
 * localized-alt controls are GONE, not merely ignored.
 */
const VariantEditor = memo(function VariantEditor({
  itemId,
  tag,
  item,
  primaryText,
  sharedMedia,
  hasArticle,
  userAvatar,
  userVerified,
  isFocused,
  isPosting,
  isTranslating,
  getFileDownloadUrl,
  onTextChange,
  onFocus,
  onTranslate,
  onSharedAltPress,
  onOwnAltPress,
  onPickOwnMedia,
  onRemoveOwnMedia,
  onUseSharedMedia,
  onArticlePress,
  onArticleReset,
}: VariantEditorProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const language = describeContentLanguage(tag);

  const handleTextChange = useCallback((text: string) => onTextChange(itemId, text), [itemId, onTextChange]);
  const handleFocus = useCallback(() => onFocus(itemId), [itemId, onFocus]);
  const handleTranslate = useCallback(() => onTranslate(itemId), [itemId, onTranslate]);
  const handlePickOwnMedia = useCallback(() => onPickOwnMedia(itemId), [itemId, onPickOwnMedia]);
  const handleUseSharedMedia = useCallback(() => onUseSharedMedia(itemId), [itemId, onUseSharedMedia]);
  const handleArticlePress = useCallback(() => onArticlePress(itemId), [itemId, onArticlePress]);
  const handleArticleReset = useCallback(() => onArticleReset(itemId), [itemId, onArticleReset]);

  const ownMedia = item.media.mode === 'override' ? item.media.media : null;
  const canTranslate = primaryText.trim().length > 0 && !isTranslating && !isPosting;

  return (
    <View style={[styles.container, !isFocused && styles.unfocused]}>
      <View style={styles.headerRow}>
        <Avatar source={userAvatar} size={AVATAR_SIZE} variant={MEDIA_VARIANT_AVATAR} verified={userVerified} style={styles.avatar} />
        <View style={styles.column}>
          <MentionTextInput
            className="text-foreground"
            style={styles.textInput}
            placeholder={t('compose.languages.variantPlaceholder', {
              defaultValue: 'Write this post in {{language}}',
              language: language.nativeName,
            })}
            value={item.text}
            onChangeText={handleTextChange}
            onFocus={handleFocus}
            multiline
          />

          {primaryText.trim().length > 0 ? (
            <View style={[styles.reference, { borderLeftColor: theme.colors.border }]}>
              <Text className="text-muted-foreground text-[13px]" numberOfLines={3}>
                {primaryText}
              </Text>
            </View>
          ) : null}

          <TouchableOpacity
            onPress={handleTranslate}
            disabled={!canTranslate}
            activeOpacity={0.75}
            className="flex-row items-center gap-1.5 self-start px-3 py-1.5 rounded-full border mt-2"
            style={{ borderColor: theme.colors.border, opacity: canTranslate ? 1 : 0.5 }}
          >
            {isTranslating ? (
              <Loading className="text-primary" variant="inline" size="small" style={loadingStyle} />
            ) : null}
            <Text className="text-[13px] font-semibold" style={{ color: theme.colors.primary }}>
              {t('compose.languages.translate', { defaultValue: 'Translate with AI' })}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {sharedMedia.length > 0 ? (
        <View style={styles.mediaSection}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.mediaScroll}
          >
            {(ownMedia ?? sharedMedia).map((media) => (
              <View
                key={media.id}
                className="border-border bg-secondary"
                style={styles.mediaCard}
              >
                {media.type === 'video' ? (
                  <VideoPreview src={getFileDownloadUrl(media.id)} />
                ) : (
                  <Image
                    source={{ uri: getFileDownloadUrl(media.id) }}
                    style={styles.mediaImage}
                    resizeMode="cover"
                  />
                )}
                {media.type === 'image' ? (
                  <ComposeAltButton
                    hasAlt={
                      ownMedia
                        ? Boolean(media.alt?.trim())
                        : item.media.mode === 'inherit' &&
                          Boolean(item.media.alt[media.id]?.trim())
                    }
                    onPress={() =>
                      ownMedia ? onOwnAltPress(itemId, media) : onSharedAltPress(itemId, media)
                    }
                  />
                ) : null}
                {ownMedia ? (
                  <TouchableOpacity
                    onPress={() => onRemoveOwnMedia(itemId, media.id)}
                    className="bg-background"
                    style={styles.mediaRemove}
                    hitSlop={HITSLOP_6}
                  >
                    <CloseIcon size={16} className="text-foreground" />
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}
            {ownMedia ? (
              <TouchableOpacity
                onPress={handlePickOwnMedia}
                activeOpacity={0.75}
                className="items-center justify-center border border-dashed border-border rounded-[15px]"
                style={styles.mediaAddCard}
              >
                <Plus size={20} color={theme.colors.textSecondary} />
                <Text className="text-[13px] mt-1" style={{ color: theme.colors.textSecondary }}>
                  {t('compose.languages.addImage', { defaultValue: 'Add image' })}
                </Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>

          <TouchableOpacity
            onPress={ownMedia ? handleUseSharedMedia : handlePickOwnMedia}
            activeOpacity={0.75}
            style={styles.mediaModeButton}
          >
            <Text className="text-[13px] font-semibold" style={{ color: theme.colors.primary }}>
              {ownMedia
                ? t('compose.languages.useSharedMedia', { defaultValue: 'Use the original images' })
                : t('compose.languages.useOwnMedia', {
                    defaultValue: 'Use different images for {{language}}',
                    language: language.nativeName,
                  })}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {hasArticle ? (
        <View style={styles.articleSection}>
          {item.article ? (
            <>
              <TouchableOpacity
                className="border-border bg-secondary"
                style={styles.articleCard}
                activeOpacity={0.85}
                onPress={handleArticlePress}
              >
                <PostArticlePreview
                  title={item.article.title}
                  body={item.article.body}
                  onPress={handleArticlePress}
                  style={styles.articlePreview}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleArticleReset} activeOpacity={0.75} style={styles.mediaModeButton}>
                <Text className="text-[13px] font-semibold" style={{ color: theme.colors.primary }}>
                  {t('compose.languages.useSharedArticle', { defaultValue: 'Use the original article' })}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={handleArticlePress} activeOpacity={0.75} style={styles.mediaModeButton}>
              <Text className="text-[13px] font-semibold" style={{ color: theme.colors.primary }}>
                {t('compose.languages.localizeArticle', {
                  defaultValue: 'Write the article in {{language}}',
                  language: language.nativeName,
                })}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}
    </View>
  );
});

const loadingStyle = { flex: undefined };

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    gap: 12,
    paddingVertical: 12,
  },
  unfocused: {
    opacity: 0.4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: HPAD,
  },
  avatar: {
    marginRight: 12,
  },
  column: {
    flex: 1,
    paddingTop: 2,
  },
  textInput: {
    fontSize: 16,
    minHeight: 40,
    textAlignVertical: 'top',
  },
  reference: {
    borderLeftWidth: 2,
    paddingLeft: 10,
    marginTop: 8,
  },
  mediaSection: {
    marginTop: 4,
  },
  mediaScroll: {
    paddingLeft: BOTTOM_LEFT_PAD,
    paddingRight: 12,
    gap: 12,
  },
  mediaCard: {
    width: MEDIA_CARD_WIDTH,
    height: MEDIA_CARD_HEIGHT,
    borderRadius: 15,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  mediaAddCard: {
    width: MEDIA_CARD_WIDTH / 2,
    height: MEDIA_CARD_HEIGHT,
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  mediaRemove: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  mediaModeButton: {
    marginLeft: BOTTOM_LEFT_PAD,
    paddingHorizontal: HPAD,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  articleSection: {
    marginTop: 4,
  },
  articleCard: {
    marginLeft: BOTTOM_LEFT_PAD,
    marginHorizontal: HPAD,
    width: MEDIA_CARD_WIDTH,
    height: MEDIA_CARD_HEIGHT,
    borderRadius: 15,
    borderWidth: 1,
    overflow: 'hidden',
  },
  articlePreview: {
    flex: 1,
    width: '100%',
    height: '100%',
    padding: 16,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
  },
});

export default VariantEditor;
