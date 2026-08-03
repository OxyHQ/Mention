import { memo, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Image,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { AccountNode } from '@oxyhq/core';
import PostArticlePreview from '@/components/Post/PostArticlePreview';
import PostAttachmentEvent from '@/components/Post/Attachments/PostAttachmentEvent';
import { PodcastCard } from '@/components/Podcast/PodcastCard';
import RoomCard from '@/components/RoomCard';
import ComposeToolbar from '@/components/ComposeToolbar';
import MentionTextInput, { MentionTextInputHandle } from '@/components/MentionTextInput';
import ComposeMentionSummary from '@/components/Compose/ComposeMentionSummary';
import { CloseIcon } from '@/assets/icons/close-icon';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { VideoPreview, PollCreator, LocationDisplay, ComposeAltButton } from '@/components/Compose';
import ComposeIdentityHeader from '@/components/Compose/ComposeIdentityHeader';
import InteractionSettingsPills from '@/components/Compose/InteractionSettingsPills';
import type { ThreadItem } from '@/hooks/useThreadManager';
import type { ComposerMediaItem } from '@/utils/composeUtils';
import type { MentionTextValue } from '@/utils/mentions';
import { HIT_SLOP_SM } from '@/styles/hitSlop';

import { HPAD, BOTTOM_LEFT_PAD } from './composeLayout';

/**
 * The exact slice of the composer's stylesheet this row renders with. The
 * composer owns the sheet, so spelling the contract out here is what makes a
 * missing or renamed entry a compile error on the parent instead of a silently
 * unstyled row.
 */
export interface ComposeThreadItemStyles {
  threadItemWithTimeline: ViewStyle;
  itemConnectorLineAbove: ViewStyle;
  itemConnectorLine: ViewStyle;
  timelineForeground: ViewStyle;
  postContainer: ViewStyle;
  unfocusedItem: ViewStyle;
  threadTextInput: TextStyle;
  toolbarWrapper: ViewStyle;
  removeThreadBtn: ViewStyle;
  mediaPreviewContainer: ViewStyle;
  mediaPreviewScroll: ViewStyle;
  mediaPreviewItem: ViewStyle;
  mediaPreviewImage: ImageStyle;
  mediaReorderControls: ViewStyle;
  mediaReorderButton: ViewStyle;
  mediaReorderButtonDisabled: ViewStyle;
  mediaRemoveButton: ViewStyle;
  pollAttachmentWrapper: ViewStyle;
  pollAttachmentCard: ViewStyle;
  pollAttachmentHeader: ViewStyle;
  pollAttachmentBadge: ViewStyle;
  pollAttachmentBadgeText: TextStyle;
  pollAttachmentMeta: TextStyle;
  pollAttachmentQuestion: TextStyle;
  pollAttachmentOptions: ViewStyle;
  pollAttachmentOption: ViewStyle;
  pollAttachmentOptionText: TextStyle;
  pollAttachmentMore: TextStyle;
  pollAttachmentRemoveButton: ViewStyle;
  articleAttachmentWrapper: ViewStyle;
  articleAttachmentPreview: ViewStyle;
}

interface ComposeThreadItemProps {
  item: ThreadItem;
  /**
   * This item's language renditions, primary body excluded. A thread item is its
   * own post, so its mentions are the union across its own renditions — the
   * summary under it has to read all of them.
   */
  variantTexts: readonly string[];
  isFocused: boolean;
  isPosting: boolean;
  postingMode: 'thread' | 'beast';
  /**
   * The account THIS post goes out as, or `null` for the author themselves.
   *
   * Already narrowed by the composer to what the payload will actually carry, so
   * the header can render it unconditionally — a value the wire would drop must
   * arrive here as `null`, or the row names an author the post will not have.
   */
  publishAs: AccountNode | null;
  // Stable callback refs — parent must wrap these in useCallback
  onMentionValueChange: (threadId: string, value: MentionTextValue) => void;
  onFocus: (threadId: string) => void;
  onRemove: (threadId: string) => void;
  onMediaPress: (threadId: string) => void;
  onPollPress: (threadId: string) => void;
  onLocationPress: (threadId: string) => void;
  onGifPress: (threadId: string) => void;
  onEmojiPress: (threadId: string) => void;
  onSourcesPress: (threadId: string) => void;
  onArticlePress: (threadId: string) => void;
  onEventPress: (threadId: string) => void;
  onRoomPress: (threadId: string) => void;
  onPollTitleChange: (threadId: string, value: string) => void;
  onPollOptionChange: (threadId: string, index: number, value: string) => void;
  onPollOptionAdd: (threadId: string) => void;
  onPollOptionRemove: (threadId: string, index: number) => void;
  onPollRemove: (threadId: string) => void;
  onLocationRemove: (threadId: string) => void;
  onMediaRemove: (threadId: string, mediaId: string) => void;
  onMediaMove: (threadId: string, mediaId: string, direction: 'left' | 'right') => void;
  onMediaAltPress: (threadId: string, mediaItem: ComposerMediaItem) => void;
  onArticleRemove: (threadId: string) => void;
  onEventRemove: (threadId: string) => void;
  onRoomRemove: (threadId: string) => void;
  onReplySettingsPress: (threadId: string) => void;
  onSensitiveToggle: (threadId: string) => void;
  onPodcastPress: (threadId: string) => void;
  onPodcastRemove: (threadId: string) => void;
  /**
   * Choose who this post is by. Omitted — leaving the avatar inert — wherever the
   * payload cannot carry another author: a thread, whose continuations are
   * replies a channel post cannot have, and a reply or an edit, where the server
   * refuses one outright.
   */
  onPublishAsPress?: (threadId: string) => void;
  /**
   * Put this post on one of its publisher's lanes. Omitted — and the icon then
   * absent from the row entirely — wherever the payload cannot carry one: in
   * THREAD mode this box is a continuation, which is a reply, and
   * `POST /posts/thread` refuses a lane on one with a 400 that fails the WHOLE
   * batch. Offering it there would take the author's choice and then lose them
   * every post in the composer.
   */
  onLanePress?: (threadId: string) => void;
  /**
   * When this post goes out, rendered in the identity row's time slot.
   *
   * The composer hands the SAME node to every box, because the publish time is a
   * property of the batch: `POST /posts/thread` reads one `scheduledFor` off the
   * top level and stamps every entry with it. A box left saying "now" beneath
   * one showing a date would be naming a publish time its post will not get.
   */
  timeSlot?: React.ReactNode;
  getFileDownloadUrl: (id: string) => string;
  textInputRef: (threadId: string, el: MentionTextInputHandle | null) => void;
  // Styles from parent
  styles: ComposeThreadItemStyles;
}

const ComposeThreadItem = memo<ComposeThreadItemProps>(({
  item,
  variantTexts,
  isFocused,
  isPosting,
  postingMode,
  publishAs,
  onMentionValueChange,
  onFocus,
  onRemove,
  onMediaPress,
  onPollPress,
  onLocationPress,
  onGifPress,
  onEmojiPress,
  onSourcesPress,
  onArticlePress,
  onEventPress,
  onRoomPress,
  onPollTitleChange,
  onPollOptionChange,
  onPollOptionAdd,
  onPollOptionRemove,
  onPollRemove,
  onLocationRemove,
  onMediaRemove,
  onMediaMove,
  onMediaAltPress,
  onArticleRemove,
  onEventRemove,
  onRoomRemove,
  onReplySettingsPress,
  onSensitiveToggle,
  onPodcastPress,
  onPodcastRemove,
  onPublishAsPress,
  onLanePress,
  timeSlot,
  getFileDownloadUrl,
  textInputRef,
  styles,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const threadId = item.id;

  // Derive attachment state
  const itemHasArticle = Boolean(item.article && (item.article.title?.trim() || item.article.body?.trim()));
  const itemHasEvent = Boolean(item.event && item.event.name?.trim());
  const itemHasRoom = Boolean(item.room && item.room.roomId);
  const itemHasSources = item.sources.length > 0 && item.sources.some(s => s.url.trim().length > 0);
  const itemHasPodcast = Boolean(item.podcast?.syraPodcastId);
  const itemHasAttachments = item.showPollCreator || item.mediaIds.length > 0 || itemHasArticle || itemHasEvent || itemHasRoom || itemHasPodcast || itemHasSources;

  // Stable callbacks bound to this thread item's id
  const handleMentionValueChange = useCallback(
    (value: MentionTextValue) => onMentionValueChange(threadId, value),
    [threadId, onMentionValueChange],
  );
  const handleFocus = useCallback(() => onFocus(threadId), [threadId, onFocus]);
  const handleRemove = useCallback(() => onRemove(threadId), [threadId, onRemove]);
  const handleMediaPress = useCallback(() => onMediaPress(threadId), [threadId, onMediaPress]);
  const handlePollPress = useCallback(() => onPollPress(threadId), [threadId, onPollPress]);
  const handleLocationPress = useCallback(() => onLocationPress(threadId), [threadId, onLocationPress]);
  const handleGifPress = useCallback(() => onGifPress(threadId), [threadId, onGifPress]);
  const handleEmojiPress = useCallback(() => onEmojiPress(threadId), [threadId, onEmojiPress]);
  const handleSourcesPress = useCallback(() => onSourcesPress(threadId), [threadId, onSourcesPress]);
  const handleArticlePress = useCallback(() => onArticlePress(threadId), [threadId, onArticlePress]);
  const handleEventPress = useCallback(() => onEventPress(threadId), [threadId, onEventPress]);
  const handleRoomPress = useCallback(() => onRoomPress(threadId), [threadId, onRoomPress]);
  const handlePollTitleChange = useCallback((v: string) => onPollTitleChange(threadId, v), [threadId, onPollTitleChange]);
  const handlePollOptionAdd = useCallback(() => onPollOptionAdd(threadId), [threadId, onPollOptionAdd]);
  const handlePollRemove = useCallback(() => onPollRemove(threadId), [threadId, onPollRemove]);
  const handleLocationRemove = useCallback(() => onLocationRemove(threadId), [threadId, onLocationRemove]);
  const handleArticleRemove = useCallback(() => onArticleRemove(threadId), [threadId, onArticleRemove]);
  const handleEventRemove = useCallback(() => onEventRemove(threadId), [threadId, onEventRemove]);
  const handleRoomRemove = useCallback(() => onRoomRemove(threadId), [threadId, onRoomRemove]);
  const handleReplySettingsPress = useCallback(() => onReplySettingsPress(threadId), [threadId, onReplySettingsPress]);
  const handleSensitiveToggle = useCallback(() => onSensitiveToggle(threadId), [threadId, onSensitiveToggle]);
  const handlePodcastPress = useCallback(() => onPodcastPress(threadId), [threadId, onPodcastPress]);
  const handlePodcastRemove = useCallback(() => onPodcastRemove(threadId), [threadId, onPodcastRemove]);
  const handleTextInputRef = useCallback((el: MentionTextInputHandle | null) => textInputRef(threadId, el), [threadId, textInputRef]);
  // Stays `undefined` when the parent supplied no handler, so the avatar is inert
  // rather than opening a picker whose answer this post could not carry.
  const handlePublishAsPress = useMemo(
    () => (onPublishAsPress ? () => onPublishAsPress(threadId) : undefined),
    [threadId, onPublishAsPress],
  );
  // Same shape, and the toolbar drops the icon entirely rather than disabling it:
  // there is nothing the author could do in a thread to make a lane land.
  const handleLanePress = useMemo(
    () => (onLanePress ? () => onLanePress(threadId) : undefined),
    [threadId, onLanePress],
  );

  /**
   * The line between avatars says "this post continues the one above it", which
   * is true in THREAD mode and false in beast mode, where every post is
   * independent and just happens to be composed alongside the others. Drawing it
   * there claims a relationship the posts will not have once they go out.
   */
  const showTimeline = postingMode === 'thread';

  const containerStyle = useMemo(() => [
    styles.postContainer,
    !isFocused && styles.unfocusedItem,
  ], [styles.postContainer, styles.unfocusedItem, isFocused]);

  const pollMarginStyle = useMemo(() => ({ marginLeft: BOTTOM_LEFT_PAD }), []);
  const interactionMarginStyle = useMemo(() => ({ marginLeft: BOTTOM_LEFT_PAD, paddingHorizontal: HPAD }), []);
  const scrollPaddingStyle = useMemo(() => [styles.mediaPreviewScroll, { paddingLeft: BOTTOM_LEFT_PAD }], [styles.mediaPreviewScroll]);

  return (
    <View style={containerStyle}>
      {showTimeline ? (
        <>
          {/* The connector's colour is the className, never an interpolated
              hex-alpha suffix on `theme.colors.primary` — that token resolves to
              `rgb(0 98 157)`, so `${primary}30` yields a malformed string
              react-native-web reads back as FULLY OPAQUE, painting a solid bar
              instead of the faint line. Geometry (incl. `left`) lives in the
              composer's own sheet entries. */}
          <View className="bg-primary/20" style={styles.itemConnectorLineAbove} />
          <View className="bg-primary/20" style={styles.itemConnectorLine} />
        </>
      ) : null}
      <View style={styles.threadItemWithTimeline}>
        {/* The SAME header the first box carries, and the same one the published
            post will: avatar, display name and handle. In beast mode the avatar
            is also the control that changes them, and this row is the whole
            disclosure of which account the post goes out as. */}
        <ComposeIdentityHeader
          publishAs={publishAs}
          onPressAvatar={handlePublishAsPress}
          timeSlot={timeSlot}
        >
          <MentionTextInput
            ref={handleTextInputRef}
            style={styles.threadTextInput}
            placeholder={t('Say more...')}
            value={item.text}
            mentions={item.mentions}
            onValueChange={handleMentionValueChange}
            onFocus={handleFocus}
            multiline
          />
          {/* Who this item will address — a thread item is its own post, so it
              carries its own mentions and its own pasted profile links. */}
          <ComposeMentionSummary
            texts={[item.text, ...variantTexts]}
            mentions={item.mentions}
          />
          <View style={styles.toolbarWrapper}>
            <ComposeToolbar
              onMediaPress={handleMediaPress}
              onPollPress={handlePollPress}
              onLocationPress={handleLocationPress}
              onGifPress={handleGifPress}
              onEmojiPress={handleEmojiPress}
              onSourcesPress={handleSourcesPress}
              onArticlePress={handleArticlePress}
              onEventPress={handleEventPress}
              onRoomPress={handleRoomPress}
              onPodcastPress={handlePodcastPress}
              onLanePress={handleLanePress}
              hasLocation={!!item.location}
              hasPoll={item.showPollCreator}
              hasMedia={item.mediaIds.length > 0}
              hasSources={item.sources.length > 0}
              hasArticle={itemHasArticle}
              hasEvent={itemHasEvent}
              hasRoom={itemHasRoom}
              hasPodcast={itemHasPodcast}
              hasLane={Boolean(item.laneId)}
              disabled={isPosting}
            />
          </View>
        </ComposeIdentityHeader>
        {/* A sibling of the header rather than a child of it: the button is
            absolutely positioned against this row's own box, and rendering it
            after the header is what puts it above the content it overlaps. */}
        <TouchableOpacity
          style={styles.removeThreadBtn}
          onPress={handleRemove}
        >
          <CloseIcon size={18} color="#5e5e5e" />
        </TouchableOpacity>

        {/* Thread item attachments row */}
        {itemHasAttachments && (
          <View style={[styles.timelineForeground, styles.mediaPreviewContainer]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={scrollPaddingStyle}
            >
              {item.showPollCreator ? (
                <View style={styles.pollAttachmentWrapper}>
                  <TouchableOpacity
                    className="border-border bg-secondary" style={styles.pollAttachmentCard}
                    activeOpacity={0.85}
                    onPress={handlePollPress}
                  >
                    <View style={styles.pollAttachmentHeader}>
                      <View className="bg-background" style={styles.pollAttachmentBadge}>
                        <PollIcon size={16} className="text-primary" />
                        <Text className="text-primary" style={styles.pollAttachmentBadgeText}>
                          {t('compose.poll.title', { defaultValue: 'Poll' })}
                        </Text>
                      </View>
                      <Text className="text-muted-foreground" style={styles.pollAttachmentMeta}>
                        {t('compose.poll.optionCount', {
                          count: item.pollOptions.length,
                          defaultValue:
                            item.pollOptions.length === 0
                              ? 'No options yet'
                              : item.pollOptions.length === 1
                                ? '1 option'
                                : `${item.pollOptions.length} options`
                        })}
                      </Text>
                    </View>
                    <Text className="text-foreground" style={styles.pollAttachmentQuestion} numberOfLines={2}>
                      {item.pollTitle?.trim() || t('compose.poll.placeholderQuestion', { defaultValue: 'Ask a question...' })}
                    </Text>
                    <View style={styles.pollAttachmentOptions}>
                      {(item.pollOptions.length > 0 ? item.pollOptions : ['', '']).slice(0, 2).map((option, index) => {
                        const trimmed = option?.trim?.() || '';
                        return (
                          <View
                            key={`thread-${threadId}-poll-opt-${index}`}
                            className="border-border bg-background" style={styles.pollAttachmentOption}
                          >
                            <Text className="text-muted-foreground" style={styles.pollAttachmentOptionText} numberOfLines={1}>
                              {trimmed || t('compose.poll.optionPlaceholder', { defaultValue: `Option ${index + 1}` })}
                            </Text>
                          </View>
                        );
                      })}
                      {item.pollOptions.length > 2 ? (
                        <Text style={[styles.pollAttachmentMore, { color: theme.colors.textTertiary }]}>
                          {t('compose.poll.moreOptions', { count: item.pollOptions.length - 2, defaultValue: `+${item.pollOptions.length - 2} more` })}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handlePollRemove}
                    className="bg-background" style={styles.pollAttachmentRemoveButton}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <CloseIcon size={16} className="text-foreground" />
                  </TouchableOpacity>
                </View>
              ) : null}
              {item.mediaIds.map((mediaItem, mediaIndex) => {
                const mediaUrl = getFileDownloadUrl(mediaItem.id);
                const mediaCount = item.mediaIds.length;
                return (
                  <View
                    key={mediaItem.id}
                    className="border-border bg-secondary" style={styles.mediaPreviewItem}
                  >
                    {mediaItem.type === 'video' ? (
                      <VideoPreview src={mediaUrl} />
                    ) : (
                      <Image
                        source={{ uri: mediaUrl }}
                        style={styles.mediaPreviewImage}
                        resizeMode="cover"
                      />
                    )}
                    {mediaItem.type === 'image' ? (
                      <ComposeAltButton
                        hasAlt={Boolean(mediaItem.alt?.trim())}
                        raised={mediaCount > 1}
                        onPress={() => onMediaAltPress(threadId, mediaItem)}
                      />
                    ) : null}
                    {mediaCount > 1 ? (
                      <View style={[styles.mediaReorderControls, pointerEventsBoxNone]}>
                        <TouchableOpacity
                          onPress={() => onMediaMove(threadId, mediaItem.id, 'left')}
                          disabled={mediaIndex === 0}
                          style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, mediaIndex === 0 && styles.mediaReorderButtonDisabled]}
                        >
                          <BackArrowIcon size={14} color={mediaIndex === 0 ? theme.colors.textTertiary : theme.colors.textSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => onMediaMove(threadId, mediaItem.id, 'right')}
                          disabled={mediaIndex === mediaCount - 1}
                          style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, mediaIndex === mediaCount - 1 && styles.mediaReorderButtonDisabled]}
                        >
                          <ChevronRightIcon size={14} color={mediaIndex === mediaCount - 1 ? theme.colors.textTertiary : theme.colors.textSecondary} />
                        </TouchableOpacity>
                      </View>
                    ) : null}
                    <TouchableOpacity
                      onPress={() => onMediaRemove(threadId, mediaItem.id)}
                      className="bg-background" style={styles.mediaRemoveButton}
                      hitSlop={HIT_SLOP_SM}
                    >
                      <CloseIcon size={16} className="text-foreground" />
                    </TouchableOpacity>
                  </View>
                );
              })}
              {/* Thread item article preview */}
              {itemHasArticle && item.article && (
                <View style={styles.pollAttachmentWrapper}>
                  <TouchableOpacity
                    className="border-border bg-secondary"
                    style={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                    activeOpacity={0.85}
                    onPress={handleArticlePress}
                  >
                    <PostArticlePreview
                      title={item.article.title}
                      body={item.article.body}
                      onPress={handleArticlePress}
                      style={styles.articleAttachmentPreview}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleArticleRemove}
                    className="bg-background" style={styles.pollAttachmentRemoveButton}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <CloseIcon size={16} className="text-foreground" />
                  </TouchableOpacity>
                </View>
              )}
              {/* Thread item event preview */}
              {itemHasEvent && item.event && (
                <View style={styles.pollAttachmentWrapper}>
                  <TouchableOpacity
                    className="border-border bg-secondary"
                    style={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                    activeOpacity={0.85}
                    onPress={handleEventPress}
                  >
                    <PostAttachmentEvent
                      name={item.event.name}
                      date={item.event.date}
                      location={item.event.location}
                      onPress={handleEventPress}
                      style={styles.articleAttachmentPreview}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleEventRemove}
                    className="bg-background" style={styles.pollAttachmentRemoveButton}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <CloseIcon size={16} className="text-foreground" />
                  </TouchableOpacity>
                </View>
              )}
              {/* Thread item podcast preview */}
              {itemHasPodcast && item.podcast && (
                <View style={styles.pollAttachmentWrapper}>
                  <View
                    className="border-border bg-card"
                    style={styles.articleAttachmentWrapper}
                  >
                    <PodcastCard
                      variant="card"
                      title={item.podcast.title}
                      author={item.podcast.author}
                      artworkUrl={item.podcast.artworkUrl}
                      onPress={handlePodcastPress}
                      style={styles.articleAttachmentPreview}
                    />
                  </View>
                  <TouchableOpacity
                    onPress={handlePodcastRemove}
                    className="bg-background" style={styles.pollAttachmentRemoveButton}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <CloseIcon size={16} className="text-foreground" />
                  </TouchableOpacity>
                </View>
              )}
              {/* Thread item room preview */}
              {itemHasRoom && item.room && (
                <View style={styles.pollAttachmentWrapper}>
                  <View
                    style={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                  >
                    <RoomCard
                      room={{
                        _id: item.room.roomId,
                        title: item.room.title,
                        status: item.room.status || 'scheduled',
                        topic: item.room.topic,
                        participants: [],
                        host: item.room.host || '',
                      }}
                      variant="compact"
                      style={styles.articleAttachmentPreview}
                    />
                  </View>
                  <TouchableOpacity
                    onPress={handleRoomRemove}
                    className="bg-background" style={styles.pollAttachmentRemoveButton}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <CloseIcon size={16} className="text-foreground" />
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </View>
        )}

        {/* Thread item poll creator */}
        {item.showPollCreator && (
          <PollCreator
            pollTitle={item.pollTitle || ''}
            onTitleChange={handlePollTitleChange}
            pollOptions={item.pollOptions}
            onOptionChange={(index, value) => onPollOptionChange(threadId, index, value)}
            onAddOption={handlePollOptionAdd}
            onRemoveOption={(index) => onPollOptionRemove(threadId, index)}
            onRemove={handlePollRemove}
            style={pollMarginStyle}
          />
        )}

        {/* Thread item location display */}
        {item.location && (
          <LocationDisplay
            location={item.location}
            onRemove={handleLocationRemove}
            style={pollMarginStyle}
          />
        )}

        {/* Per-item interaction settings (beast mode only) */}
        {postingMode === 'beast' && (
          <View style={interactionMarginStyle}>
            <InteractionSettingsPills
              replyPermission={item.replyPermission}
              quotesDisabled={item.quotesDisabled}
              isSensitive={item.isSensitive}
              onReplySettingsPress={handleReplySettingsPress}
              onSensitiveToggle={handleSensitiveToggle}
            />
          </View>
        )}
      </View>
    </View>
  );
});

// Stable style objects to avoid re-creating on each render
const pointerEventsBoxNone = { pointerEvents: 'box-none' as const };

ComposeThreadItem.displayName = 'ComposeThreadItem';

export default ComposeThreadItem;
