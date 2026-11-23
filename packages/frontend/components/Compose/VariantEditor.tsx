import { memo, useCallback, type ReactNode, type Ref } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import type { AvatarProps } from '@oxy.so/bloom/avatar';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import MentionTextInput, { type MentionTextInputHandle } from '@/components/MentionTextInput';
import PostArticlePreview from '@/components/Post/PostArticlePreview';
import { ComposeAltButton } from '@/components/Compose/ComposeAltButton';
import { ComposeMediaPreview } from '@/components/Compose/ComposeMediaPreview';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { describeContentLanguage } from '@/constants/contentLanguages';
import { MEDIA_CARD_HEIGHT, MEDIA_CARD_WIDTH, type ComposerMediaItem } from '@/utils/composeUtils';
import type { ComposeVariantItem } from '@/utils/composeVariants';
import {
  AVATAR_SIZE,
  BOTTOM_LEFT_PAD,
  HPAD,
  cardRemoveControl,
  composeSpace,
} from './composeLayout';
import type { MentionData, MentionTextValue } from '@/utils/mentions';

import { Embed, HStack, Icon, Loading, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
  account?: AvatarProps['account'];
  userVerified: boolean;
  isFocused: boolean;
  isPosting: boolean;
  isTranslating: boolean;
  getFileDownloadUrl: (id: string) => string;
  mentions: readonly MentionData[];
  onMentionValueChange: (itemId: string, value: MentionTextValue) => void;
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
  textInputRef?: Ref<MentionTextInputHandle>;
  /** Keeps the same composer actions available in every language. */
  toolbar?: ReactNode;
}

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
  account,
  userVerified,
  isFocused,
  isPosting,
  isTranslating,
  getFileDownloadUrl,
  mentions,
  onMentionValueChange,
  onFocus,
  onTranslate,
  onSharedAltPress,
  onOwnAltPress,
  onPickOwnMedia,
  onRemoveOwnMedia,
  onUseSharedMedia,
  onArticlePress,
  onArticleReset,
  textInputRef,
  toolbar,
}: VariantEditorProps) {
  const { t } = useTranslation();
  const colorTokens = useColorTokens();
  const language = describeContentLanguage(tag);

  const handleMentionValueChange = useCallback(
    (value: MentionTextValue) => onMentionValueChange(itemId, value),
    [itemId, onMentionValueChange],
  );
  const handleFocus = useCallback(() => onFocus(itemId), [itemId, onFocus]);
  const handleTranslate = useCallback(() => onTranslate(itemId), [itemId, onTranslate]);
  const handlePickOwnMedia = useCallback(() => onPickOwnMedia(itemId), [itemId, onPickOwnMedia]);
  const handleUseSharedMedia = useCallback(
    () => onUseSharedMedia(itemId),
    [itemId, onUseSharedMedia],
  );
  const handleArticlePress = useCallback(() => onArticlePress(itemId), [itemId, onArticlePress]);
  const handleArticleReset = useCallback(() => onArticleReset(itemId), [itemId, onArticleReset]);

  const ownMedia = item.media.mode === 'override' ? item.media.media : null;
  const canTranslate = primaryText.trim().length > 0 && !isTranslating && !isPosting;

  return (
    <View style={[styles.container, !isFocused && styles.unfocused]}>
      <View style={styles.headerRow}>
        <AccountAvatar
          account={account}
          source={userAvatar}
          size={AVATAR_SIZE}
          variant={MEDIA_VARIANT_AVATAR}
          verified={userVerified}
          style={styles.avatar}
        />
        {toElement(
          VStack(
            Embed(
              <MentionTextInput
                ref={textInputRef}
                style={styles.textInput}
                placeholder={t('compose.languages.variantPlaceholder', {
                  defaultValue: 'Write this post in {{language}}',
                  language: language.nativeName,
                })}
                value={item.text}
                mentions={mentions}
                onValueChange={handleMentionValueChange}
                onFocus={handleFocus}
                multiline
              />,
            ),
            Embed(
              primaryText.trim().length > 0 ? (
                <View style={[styles.reference, { borderLeftColor: colorTokens.border }]}>
                  {toElement(RawText(primaryText).foreground('muted').font('sm').lines(3))}
                </View>
              ) : null,
            ),
            HStack(
              isTranslating ? Loading().style('inline').size('sm') : null,
              RawText(t('compose.languages.translate', { defaultValue: 'Translate with AI' }))
                .font('sm')
                .weight('semibold')
                .foreground('primary'),
            )
              .align('center')
              .spacing('6')
              .padding('horizontal', 'md')
              .padding('vertical', '6')
              .border('border', 'thin')
              .corner('infinite')
              .opacity(canTranslate ? 'opaque' : 'half')
              .margin('top', 'sm')
              .alignSelf('start')
              .onPress(handleTranslate)
              .disabled(!canTranslate)
              .pressFade('75'),
          )
            .padding('top', '2xs')
            .grow(),
        )}
      </View>
      {toolbar}
      {sharedMedia.length > 0
        ? toElement(
            VStack(
              Embed(
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.mediaScroll}
                >
                  {(ownMedia ?? sharedMedia).map((media) =>
                    toElement(
                      VStack(
                        Embed(
                          <ComposeMediaPreview
                            type={media.type}
                            uri={getFileDownloadUrl(media.id)}
                            imageStyle={styles.mediaImage}
                          />,
                        ),
                        media.type === 'image'
                          ? Embed(
                              <ComposeAltButton
                                hasAlt={
                                  ownMedia
                                    ? Boolean(media.alt?.trim())
                                    : item.media.mode === 'inherit' &&
                                      Boolean(item.media.alt[media.id]?.trim())
                                }
                                onPress={() =>
                                  ownMedia
                                    ? onOwnAltPress(itemId, media)
                                    : onSharedAltPress(itemId, media)
                                }
                              />,
                            )
                          : null,
                        ownMedia
                          ? cardRemoveControl(() => onRemoveOwnMedia(itemId, media.id)).hitSlop(
                              'sm',
                            )
                          : null,
                      )
                        .frame({ width: '280', height: composeSpace.space.cardHeight })
                        .background('mutedFill')
                        .border('border', 'thin')
                        .corner('15')
                        .clipped(),
                      media.id,
                    ),
                  )}
                  {ownMedia
                    ? toElement(
                        /* Add an image: a dashed slot beside the images, half a card wide. */
                        VStack(
                          Icon(RiAddLine).size('md').foreground('muted'),
                          RawText(t('compose.languages.addImage', { defaultValue: 'Add image' }))
                            .font('sm')
                            .margin('top', 'xs')
                            .foreground('muted'),
                        )
                          .align('center')
                          .justify('center')
                          .frame({ width: '140', height: composeSpace.space.cardHeight })
                          .border('border', 'thin')
                          .borderStyle('dashed')
                          .corner('15')
                          .onPress(handlePickOwnMedia)
                          .pressFade('75'),
                      )
                    : null}
                </ScrollView>,
              ),
              mediaModeButton(
                ownMedia
                  ? t('compose.languages.useSharedMedia', {
                      defaultValue: 'Use the original images',
                    })
                  : t('compose.languages.useOwnMedia', {
                      defaultValue: 'Use different images for {{language}}',
                      language: language.nativeName,
                    }),
                ownMedia ? handleUseSharedMedia : handlePickOwnMedia,
              ),
            ).margin('top', 'xs'),
          )
        : null}
      {hasArticle
        ? toElement(
            VStack(
              Embed(
                item.article ? (
                  <>
                    <TouchableOpacity
                      style={[
                        { borderColor: colorTokens.border, backgroundColor: colorTokens.muted },
                        styles.articleCard,
                      ]}
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
                    {toElement(
                      mediaModeButton(
                        t('compose.languages.useSharedArticle', {
                          defaultValue: 'Use the original article',
                        }),
                        handleArticleReset,
                      ),
                    )}
                  </>
                ) : (
                  toElement(
                    mediaModeButton(
                      t('compose.languages.localizeArticle', {
                        defaultValue: 'Write the article in {{language}}',
                        language: language.nativeName,
                      }),
                      handleArticlePress,
                    ),
                  )
                ),
              ),
            ).margin('top', 'xs'),
          )
        : null}
    </View>
  );
});

/** A text action under the attachments, in line with the text column (`ml-[68px] px-4 py-2 self-start`). */
const mediaModeButton = (label: string, onPress: () => void) =>
  VStack(RawText(label).font('sm').weight('semibold').foreground('primary'))
    .padding('horizontal', 'lg')
    .padding('vertical', 'sm')
    .margin('left', composeSpace.space.bottomLeftPad)
    .alignSelf('start')
    .onPress(onPress)
    .pressFade('75');

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
  mediaImage: {
    width: '100%',
    height: '100%',
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
