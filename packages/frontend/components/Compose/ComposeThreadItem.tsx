import React, { memo, useCallback, useMemo, Suspense, lazy } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Image,
} from 'react-native';
import Avatar from '@/components/Avatar';
import PostArticlePreview from '@/components/Post/PostArticlePreview';
import PostAttachmentEvent from '@/components/Post/Attachments/PostAttachmentEvent';
import RoomCard from '@/components/RoomCard';
import ComposeToolbar from '@/components/ComposeToolbar';
import MentionTextInput, { MentionTextInputHandle } from '@/components/MentionTextInput';
import { CloseIcon } from '@/assets/icons/close-icon';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { VideoPreview, PollCreator, LocationDisplay } from '@/components/Compose';
import InteractionSettingsPills from '@/components/Compose/InteractionSettingsPills';
import type { ThreadItem } from '@/hooks/useThreadManager';
import type { StyleProp, ViewStyle } from 'react-native';

const ReplySettingsSheet = lazy(() => import('@/components/Compose/ReplySettingsSheet'));

import { HPAD, AVATAR_SIZE, BOTTOM_LEFT_PAD, TIMELINE_LINE_OFFSET } from './composeLayout';

interface ComposeThreadItemProps {
  item: ThreadItem;
  isFocused: boolean;
  isPosting: boolean;
  postingMode: 'thread' | 'beast';
  userAvatar: string | undefined;
  userVerified: boolean;
  // Stable callback refs — parent must wrap these in useCallback
  onTextChange: (threadId: string, text: string) => void;
  onMentionsChange: (threadId: string, mentions: any[]) => void;
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
  onArticleRemove: (threadId: string) => void;
  onEventRemove: (threadId: string) => void;
  onRoomRemove: (threadId: string) => void;
  onReplySettingsPress: (threadId: string) => void;
  onSensitiveToggle: (threadId: string) => void;
  getFileDownloadUrl: (id: string) => string;
  textInputRef: (threadId: string, el: MentionTextInputHandle | null) => void;
  // Styles from parent
  styles: Record<string, any>;
}

const HITSLOP_6 = { top: 6, bottom: 6, left: 6, right: 6 };

const ComposeThreadItem = memo<ComposeThreadItemProps>(({
  item,
  isFocused,
  isPosting,
  postingMode,
  userAvatar,
  userVerified,
  onTextChange,
  onMentionsChange,
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
  onArticleRemove,
  onEventRemove,
  onRoomRemove,
  onReplySettingsPress,
  onSensitiveToggle,
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
  const itemHasAttachments = item.showPollCreator || item.mediaIds.length > 0 || itemHasArticle || itemHasEvent || itemHasRoom || itemHasSources;

  // Stable callbacks bound to this thread item's id
  const handleTextChange = useCallback((v: string) => onTextChange(threadId, v), [threadId, onTextChange]);
  const handleMentionsChange = useCallback((m: any[]) => onMentionsChange(threadId, m), [threadId, onMentionsChange]);
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
  const handleTextInputRef = useCallback((el: MentionTextInputHandle | null) => textInputRef(threadId, el), [threadId, textInputRef]);

  // Memoize connector line styles
  const connectorAboveStyle = useMemo(() => [
    styles.itemConnectorLineAbove,
    { left: TIMELINE_LINE_OFFSET, backgroundColor: `${theme.colors.primary}30` },
  ], [styles.itemConnectorLineAbove, theme.colors.primary]);

  const connectorBelowStyle = useMemo(() => [
    styles.itemConnectorLine,
    { left: TIMELINE_LINE_OFFSET, backgroundColor: `${theme.colors.primary}30` },
  ], [styles.itemConnectorLine, theme.colors.primary]);

  const containerStyle = useMemo(() => [
    styles.postContainer,
    !isFocused && styles.unfocusedItem,
  ], [styles.postContainer, styles.unfocusedItem, isFocused]);

  const headerRowStyle = useMemo(() => [
    styles.headerRow,
    { paddingHorizontal: HPAD },
  ], [styles.headerRow]);

  const pollMarginStyle = useMemo(() => ({ marginLeft: BOTTOM_LEFT_PAD }), []);
  const interactionMarginStyle = useMemo(() => ({ marginLeft: BOTTOM_LEFT_PAD, paddingHorizontal: HPAD }), []);
  const scrollPaddingStyle = useMemo(() => [styles.mediaPreviewScroll, { paddingLeft: BOTTOM_LEFT_PAD }], [styles.mediaPreviewScroll]);

  return (
    <View style={containerStyle}>
      <View style={connectorAboveStyle} />
      <View style={connectorBelowStyle} />
      <View style={styles.threadItemWithTimeline}>
        <View style={headerRowStyle}>
          <TouchableOpacity activeOpacity={0.7}>
            <Avatar
              source={userAvatar}
              size={40}
              verified={userVerified}
              style={avatarStyle}
            />
          </TouchableOpacity>
          <View style={styles.headerMeta}>
            <View style={styles.headerChildren}>
              <MentionTextInput
                ref={handleTextInputRef}
                style={styles.threadTextInput}
                placeholder={t('Say more...')}
                value={item.text}
                onChangeText={handleTextChange}
                onMentionsChange={handleMentionsChange}
                onFocus={handleFocus}
                multiline
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
                  hasLocation={!!item.location}
                  hasPoll={item.showPollCreator}
                  hasMedia={item.mediaIds.length > 0}
                  hasSources={item.sources.length > 0}
                  hasArticle={itemHasArticle}
                  hasEvent={itemHasEvent}
                  hasRoom={itemHasRoom}
                  disabled={isPosting}
                />
              </View>
              <TouchableOpacity
                style={styles.removeThreadBtn}
                onPress={handleRemove}
              >
                <CloseIcon size={18} color="#5e5e5e" />
              </TouchableOpacity>
            </View>
          </View>
        </View>

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
                    hitSlop={HITSLOP_6}
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
                      hitSlop={HITSLOP_6}
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
                    hitSlop={HITSLOP_6}
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
                    hitSlop={HITSLOP_6}
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
                    hitSlop={HITSLOP_6}
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
const avatarStyle = { marginRight: 12 };
const pointerEventsBoxNone = { pointerEvents: 'box-none' as const };

ComposeThreadItem.displayName = 'ComposeThreadItem';

export default ComposeThreadItem;
