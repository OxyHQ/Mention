import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ScrollView,
  Image,
  Modal,
} from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useAuth } from '@oxyhq/services';
import { StatusBar } from 'expo-status-bar';
import * as ExpoLocation from 'expo-location';
import { ThemedView } from '@/components/ThemedView';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../styles/colors';
import Avatar from '@/components/Avatar';
import PostHeader from '@/components/Post/PostHeader';
import PostArticlePreview from '@/components/Post/PostArticlePreview';
import PostAttachmentEvent from '@/components/Post/Attachments/PostAttachmentEvent';
import ComposeToolbar from '@/components/ComposeToolbar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePostsStore } from '../stores/postsStore';
import { GeoJSONPoint } from '@mention/shared-types';
import { useTheme } from '@/hooks/useTheme';
import MentionTextInput, { MentionData, MentionTextInputHandle } from '@/components/MentionTextInput';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { DraftsIcon } from '@/assets/icons/drafts';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { CloseIcon } from '@/assets/icons/close-icon';
import { DotIcon } from '@/assets/icons/dot-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { HideIcon } from '@/assets/icons/hide-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { BottomSheetContext } from '@/context/BottomSheetContext';
// Lazy load sheets - only loaded when user opens them
const DraftsSheet = lazy(() => import('@/components/Compose/DraftsSheet'));
const GifPickerSheet = lazy(() => import('@/components/Compose/GifPickerSheet'));
const EmojiPickerSheet = lazy(() => import('@/components/Compose/EmojiPickerSheet'));
const SourcesSheet = lazy(() => import('@/components/Compose/SourcesSheet'));
const ScheduleSheet = lazy(() => import('@/components/Compose/ScheduleSheet'));
// Import types separately (not lazy loaded)
import type { ReplyPermission } from '@/components/Compose/ReplySettingsSheet';
import type { ScheduleOption } from '@/components/Compose/ScheduleSheet';
const ReplySettingsSheet = lazy(() => import('@/components/Compose/ReplySettingsSheet'));
import { Toggle } from '@/components/Toggle';
import { useDrafts } from '@/hooks/useDrafts';

// New imports for refactored components and hooks
import { useLocationManager } from '@/hooks/useLocationManager';
import { useMediaManager } from '@/hooks/useMediaManager';
import { usePollManager } from '@/hooks/usePollManager';
import { useSourcesManager } from '@/hooks/useSourcesManager';
import { useThreadManager } from '@/hooks/useThreadManager';
import { useArticleManager } from '@/hooks/useArticleManager';
import { useEventManager } from '@/hooks/useEventManager';
import { useAttachmentOrder } from '@/hooks/useAttachmentOrder';
import { usePostSubmission } from '@/hooks/usePostSubmission';
import { useScheduleManager } from '@/hooks/useScheduleManager';
import { useDraftManager } from '@/hooks/useDraftManager';
import { useComposeValidation } from '@/hooks/useComposeValidation';
import { useMediaPicker } from '@/hooks/useMediaPicker';
import { useMultiRefSync } from '@/hooks/useRefSync';
import { useUrlUtils } from '@/hooks/useUrlUtils';
import { useSourcesSheet } from '@/hooks/useSourcesSheet';
import { useLinkDetection } from '@/hooks/useLinkDetection';
import { LinkPreview, LinkPreviewLoading } from '@/components/Compose/LinkPreview';
import {
  PollCreator,
  PollAttachmentCard,
  MediaPreview,
  VideoPreview,
  ArticleEditor,
  EventEditor,
  LocationDisplay,
} from '@/components/Compose';
import { buildAttachmentsPayload } from '@/utils/attachmentsUtils';
import { formatScheduledLabel, addMinutes } from '@/utils/dateUtils';
import { buildMainPost, buildThreadPost, shouldIncludeThreadItem } from '@/utils/postBuilder';
import {
  ComposerMediaItem,
  toComposerMediaType,
  MEDIA_CARD_WIDTH,
  MEDIA_CARD_HEIGHT,
  POLL_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  EVENT_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  LINK_ATTACHMENT_KEY,
  createMediaAttachmentKey,
  isMediaAttachmentKey,
  getMediaIdFromAttachmentKey,
} from '@/utils/composeUtils';

// Keep this in sync with PostItem constants
const HPAD = 16;
const AVATAR_SIZE = 40;
const AVATAR_GAP = 12;
const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52
const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET; // 68
const TIMELINE_LINE_OFFSET = HPAD + AVATAR_SIZE / 2 - 1; // Center timeline on avatar

const ComposeScreen = () => {
  const theme = useTheme();
  const bottomSheet = React.useContext(BottomSheetContext);
  const { saveDraft, deleteDraft, loadDrafts } = useDrafts();
  const { user, showBottomSheet, oxyServices } = useAuth();
  const { createPost, createThread } = usePostsStore();
  const { t } = useTranslation();

  // Use custom hooks for state management
  const mediaManager = useMediaManager();
  const pollManager = usePollManager();
  const locationManager = useLocationManager();
  const sourcesManager = useSourcesManager();
  const threadManager = useThreadManager();
  const articleManager = useArticleManager();
  const eventManager = useEventManager();

  // Destructure for easier access (need these first for useAttachmentOrder)
  const { mediaIds, setMediaIds, addMedia, addMultipleMedia, removeMedia, moveMedia } = mediaManager;
  const {
    pollTitle,
    setPollTitle,
    pollOptions,
    setPollOptions,
    showPollCreator,
    setShowPollCreator,
    pollTitleInputRef,
    focusPollCreator,
    addPollOption,
    updatePollOption,
    removePollOption,
    removePoll,
  } = pollManager;
  const { location, setLocation, isGettingLocation, requestLocation, removeLocation } = locationManager;
  const { sources, setSources, addSource, updateSourceField, removeSource: removeSourceEntry, getSanitizedSources, hasInvalidSources } = sourcesManager;
  const {
    threadItems,
    addThread,
    removeThread,
    updateThreadText,
    updateThreadMentions,
    addThreadMedia,
    addThreadMediaMultiple,
    removeThreadMedia,
    moveThreadMedia,
    openThreadPollCreator,
    addThreadPollOption,
    updateThreadPollOption,
    removeThreadPollOption,
    removeThreadPoll,
    updateThreadPollTitle,
    setThreadLocation,
    removeThreadLocation,
    clearAllThreads,
    loadThreadsFromDraft,
  } = threadManager;
  const {
    article,
    setArticle,
    isArticleEditorVisible,
    articleDraftTitle,
    setArticleDraftTitle,
    articleDraftBody,
    setArticleDraftBody,
    openArticleEditor,
    closeArticleEditor,
    saveArticle: handleArticleSave,
    removeArticle,
    hasContent: articleHasContent,
    loadArticleFromDraft,
    clearArticle,
  } = articleManager;
  const {
    event,
    setEvent,
    isEventEditorVisible,
    eventDraftName,
    setEventDraftName,
    eventDraftDate,
    setEventDraftDate,
    eventDraftLocation,
    setEventDraftLocation,
    eventDraftDescription,
    setEventDraftDescription,
    openEventEditor,
    closeEventEditor,
    saveEvent: handleEventSave,
    removeEvent,
    hasContent: eventHasContent,
    loadEventFromDraft,
    clearEvent,
  } = eventManager;

  const hasArticleContent = articleHasContent();
  const hasEventContent = eventHasContent();

  // Remaining local state
  const [postContent, setPostContent] = useState('');
  const [mentions, setMentions] = useState<MentionData[]>([]);
  const [isPosting, setIsPosting] = useState(false);
  const [postingMode, setPostingMode] = useState<'thread' | 'beast'>('thread');
  const [replyPermission, setReplyPermission] = useState<ReplyPermission>('anyone');
  const [reviewReplies, setReviewReplies] = useState(false);
  const [showModeToggle, setShowModeToggle] = useState(false);

  const scheduleEnabled = postingMode === 'thread' && threadItems.length === 0;

  // Schedule manager
  const scheduleManager = useScheduleManager({
    scheduleEnabled,
    bottomSheet,
    t,
    toast,
  });
  const {
    scheduledAt,
    setScheduledAt,
    scheduledAtRef,
    formatScheduledLabel,
    clearSchedule,
    handleScheduleSelect,
    handleScheduleClear,
    handleScheduleClose,
    openScheduleSheet,
  } = scheduleManager;

  // Draft manager
  const draftManager = useDraftManager({
    saveDraft,
    deleteDraft,
    onDraftLoad: (draft) => {
      setPostContent(draft.postContent);
      setMediaIds(draft.mediaIds);
      setPollOptions(draft.pollOptions);
      setPollTitle(draft.pollTitle);
      setShowPollCreator(draft.showPollCreator);
      setLocation(draft.location);
      setSources(draft.sources);
      setArticle(draft.article);
      setArticleDraftTitle(draft.articleDraftTitle);
      setArticleDraftBody(draft.articleDraftBody);
      setScheduledAt(draft.scheduledAt);
      if (draft.scheduledAt) {
        scheduledAtRef.current = draft.scheduledAt;
      }
      setAttachmentOrder(draft.attachmentOrder);
      setMentions(draft.mentions);
      setPostingMode(draft.postingMode);
      loadThreadsFromDraft(draft.threadItems);
    },
  });
  const {
    currentDraftId,
    setCurrentDraftId,
    autoSaveTimeoutRef,
    autoSave: autoSaveDraft,
    loadDraft,
  } = draftManager;

  // Validation
  const validation = useComposeValidation({
    postContent,
    mediaIds,
    pollOptions,
    location,
    hasArticleContent,
    threadItems,
    sources,
    isPosting,
  });
  const { canPostContent, hasInvalidSources: invalidSources, isPostButtonEnabled } = validation;

  // Media picker
  const mediaPicker = useMediaPicker({
    showBottomSheet,
    setMediaIds,
    t,
  });
  const { openMediaPicker } = mediaPicker;

  // URL utilities
  const urlUtils = useUrlUtils();
  const { normalizeUrl, isValidSourceUrl, sanitizeSourcesForSubmit } = urlUtils;

  // Sources sheet management
  const sourcesSheet = useSourcesSheet({
    sources,
    addSource,
    updateSourceField,
    removeSourceEntry,
    isValidSourceUrl,
    bottomSheet,
  });
  const { isSourcesSheetOpen, openSourcesSheet, closeSourcesSheet } = sourcesSheet;

  // Link detection and preview (must be before useAttachmentOrder)
  const linkDetection = useLinkDetection(postContent);
  const { detectedLinks, isLoading: isLoadingLinks } = linkDetection;

  // Attachment order manager (needs detectedLinks)
  const attachmentOrderManager = useAttachmentOrder({
    showPollCreator,
    hasArticleContent,
    article,
    hasEventContent,
    event,
    location,
    sources,
    mediaIds,
    hasLink: detectedLinks.length > 0,
    setMediaIds,
  });
  const { attachmentOrder, setAttachmentOrder, clearAttachmentOrder, moveAttachment } = attachmentOrderManager;

  // Sync refs with state for timeout/async callbacks
  const refs = useMultiRefSync({
    postContent,
    mediaIds,
    pollOptions,
    pollTitle,
    showPollCreator,
    location,
    sources,
    threadItems,
    mentions,
    postingMode,
    currentDraftId,
    article,
    attachmentOrder,
  });
  const postContentRef = refs.postContent;
  const mediaIdsRef = refs.mediaIds;
  const pollOptionsRef = refs.pollOptions;
  const pollTitleRef = refs.pollTitle;
  const showPollCreatorRef = refs.showPollCreator;
  const locationRef = refs.location;
  const sourcesRef = refs.sources;
  const threadItemsRef = refs.threadItems;
  const mentionsRef = refs.mentions;
  const postingModeRef = refs.postingMode;
  const currentDraftIdRef = refs.currentDraftId;
  const articleRef = refs.article;
  const attachmentOrderRef = refs.attachmentOrder;
  const threadPollTitleRefs = useRef<Record<string, TextInput | null>>({});
  const mainTextInputRef = useRef<MentionTextInputHandle>(null);
  const threadTextInputRefs = useRef<Record<string, MentionTextInputHandle | null>>({});
  // Note: scheduledAtRef comes from scheduleManager

  const generateSourceId = useCallback(() => `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, []);

  // Keep this in sync with PostItem constants
  const HPAD = 16;
  const AVATAR_SIZE = 40;
  const AVATAR_GAP = 12;
  const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52
  const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET; // 68
  const TIMELINE_LINE_OFFSET = HPAD + AVATAR_SIZE / 2 - 1; // Center timeline on avatar

  const handlePost = async () => {
    if (isPosting || !user) return;
    if (scheduledAt && !scheduleEnabled) {
      toast.error(t('compose.schedule.threadsUnsupported', { defaultValue: 'Scheduling threads is not supported yet' }));
      return;
    }

    const scheduledAtValue = scheduledAt;
    const wasScheduled = Boolean(scheduledAtValue);
    const hasText = postContent.trim().length > 0;
    const hasMedia = mediaIds.length > 0;
    const hasPoll = pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0);

    if (!(hasText || hasMedia || hasPoll || hasArticleContent || hasEventContent)) {
      toast.error(t('Add text, an image, a poll, or an article'));
      return;
    }

    setIsPosting(true);
    try {
      // Prepare all posts (main + thread items)
      const allPosts = [];
      const formattedSources = sanitizeSourcesForSubmit(sources);

      // Build main post
      const mainPost = buildMainPost({
        postContent,
        mentions,
        mediaIds,
        pollTitle,
        pollOptions,
        article,
        hasArticleContent,
        event,
        hasEventContent,
        location,
        formattedSources,
        attachmentOrder: attachmentOrderRef.current || attachmentOrder,
        replyPermission,
        reviewReplies,
        scheduledAt: scheduledAtRef.current,
      });
      allPosts.push(mainPost);

      // Add thread items if any
      threadItems.forEach(item => {
        if (shouldIncludeThreadItem(item)) {
          const threadPost = buildThreadPost(item, replyPermission, reviewReplies);
          allPosts.push(threadPost);
        }
      });

      // Send to backend based on whether we have multiple posts or just one
      if (allPosts.length === 1) {
        await createPost(allPosts[0] as any);
      } else {
        await createThread({
          mode: postingMode,
          posts: allPosts as any
        });
      }

      // Clear current draft if it exists
      if (currentDraftId) {
        await deleteDraft(currentDraftId);
        setCurrentDraftId(null);
      }

      const successMessage = wasScheduled && scheduledAtValue
        ? t('compose.schedule.success', { defaultValue: 'Post scheduled for {{time}}', time: formatScheduledLabel(scheduledAtValue) })
        : t('Post published successfully');
      toast.success(successMessage);

      clearSchedule({ silent: true });

      setArticle(null);
      setArticleDraftTitle('');
      setArticleDraftBody('');
      setEvent(null);
      setEventDraftName('');
      setEventDraftDate('');
      setEventDraftLocation('');
      setEventDraftDescription('');

      // Navigate back after posting
      router.back();
    } catch (error: any) {
      toast.error(t('Failed to publish post'));
    } finally {
      setIsPosting(false);
    }
  };

  // Debounced auto-save - trigger when any content changes
  useEffect(() => {
    // Don't auto-save on initial mount
    if (!postContent && mediaIds.length === 0 && pollOptions.length === 0 && !location && threadItems.length === 0) {
      return;
    }

    // Clear existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    // Set new timeout for auto-save (2 seconds after last change)
    autoSaveTimeoutRef.current = setTimeout(() => {
      autoSaveDraft({
        postContent,
        mediaIds,
        pollOptions,
        pollTitle,
        showPollCreator,
        location,
        sources,
        article,
        threadItems,
        mentions,
        postingMode,
        attachmentOrder,
        scheduledAt,
        currentDraftId,
      });
    }, 2000);

    // Cleanup on unmount
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [postContent, mediaIds, pollOptions, pollTitle, showPollCreator, location, sources, threadItems, mentions, postingMode, attachmentOrder, scheduledAt, article, currentDraftId, autoSaveDraft, autoSaveTimeoutRef]);

  // back navigation

  // Thread item functions
  const openThreadMediaPicker = (threadId: string) => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: true,
        disabledMimeTypes: ['audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: any) => {
          const isImage = file?.contentType?.startsWith?.('image/');
          const isVideo = file?.contentType?.startsWith?.('video/');
          if (!isImage && !isVideo) {
            toast.error(t('Please select an image or video file'));
            return;
          }
          try {
            const resolvedType = toComposerMediaType(isImage ? 'image' : 'video', file?.contentType);
            const mediaItem: ComposerMediaItem = { id: file.id, type: resolvedType };
            addThreadMedia(threadId, mediaItem);
            toast.success(t(isImage ? 'Image attached' : 'Video attached'));
          } catch (e: any) {
            toast.error(e?.message || t('Failed to attach media'));
          }
        },
        onConfirmSelection: async (files: any[]) => {
          const validFiles = (files || []).filter(f => {
            const contentType = f?.contentType || '';
            return contentType.startsWith('image/') || contentType.startsWith('video/');
          });
          if (validFiles.length !== (files || []).length) {
            toast.error(t('Please select only image or video files'));
          }
          const mediaItems = validFiles.map(f => ({
            id: f.id,
            type: toComposerMediaType(f.contentType?.startsWith('image/') ? 'image' : 'video', f.contentType)
          }));
          addThreadMediaMultiple(threadId, mediaItems);
        }
      }
    });
  };

  // Thread location functions
  const requestThreadLocation = async (threadId: string) => {
    try {
      // Request permissions
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        toast.error(t('Location permission denied'));
        return;
      }

      // Get current position
      const currentLocation = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.Balanced,
      });

      // Reverse geocode to get address
      const reverseGeocode = await ExpoLocation.reverseGeocodeAsync({
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
      });

      const address = reverseGeocode[0];
      const locationData = {
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
        address: address
          ? `${address.city || address.subregion || ''}, ${address.region || ''}`
          : `${currentLocation.coords.latitude.toFixed(4)}, ${currentLocation.coords.longitude.toFixed(4)}`
      };

      setThreadLocation(threadId, locationData);
      toast.success(t('Location added'));
    } catch (error) {
      toast.error(t('Failed to get location'));
    }
  };

  const { t: tCompose } = useTranslation();

  const getReplyPermissionText = () => {
    switch (replyPermission) {
      case 'anyone':
        return t('Anyone can reply & quote');
      case 'followers':
        return t('Your followers can reply & quote');
      case 'following':
        return t('Profiles you follow can reply & quote');
      case 'mentioned':
        return t('Profiles you mention can reply & quote');
      default:
        return t('Anyone can reply & quote');
    }
  };

  const [isReplySettingsOpen, setIsReplySettingsOpen] = useState(false);

  // Wrapper for openScheduleSheet to pass ScheduleSheet component
  const handleSchedulePress = useCallback(() => {
    openScheduleSheet(ScheduleSheet);
  }, [openScheduleSheet]);

  // Update bottom sheet content when replyPermission or reviewReplies changes
  useEffect(() => {
    if (isReplySettingsOpen) {
      bottomSheet.setBottomSheetContent(
        <Suspense fallback={null}>
          <ReplySettingsSheet
            onClose={() => {
              bottomSheet.openBottomSheet(false);
              setIsReplySettingsOpen(false);
            }}
            replyPermission={replyPermission}
            onReplyPermissionChange={setReplyPermission}
            reviewReplies={reviewReplies}
            onReviewRepliesChange={setReviewReplies}
          />
        </Suspense>
      );
    }
  }, [replyPermission, reviewReplies, isReplySettingsOpen]);

  const openReplySettings = () => {
    setIsReplySettingsOpen(true);
    bottomSheet.setBottomSheetContent(
      <Suspense fallback={null}>
        <ReplySettingsSheet
          onClose={() => {
            bottomSheet.openBottomSheet(false);
            setIsReplySettingsOpen(false);
          }}
          replyPermission={replyPermission}
          onReplyPermissionChange={setReplyPermission}
          reviewReplies={reviewReplies}
          onReviewRepliesChange={setReviewReplies}
        />
      </Suspense>
    );
    bottomSheet.openBottomSheet(true);
  };

  useEffect(() => {
    if (!scheduleEnabled && scheduledAt) {
      clearSchedule({ silent: true });
    }
  }, [scheduleEnabled, scheduledAt, clearSchedule]);

  return (
    <>
      <SEO
        title={tCompose('seo.compose.title')}
        description={tCompose('seo.compose.description')}
      />
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar style="light" />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.composeArea}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <ThemedView style={{ flex: 1 }}>

            {/* Header */}
            <View style={[styles.header, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }]}>
              <IconButton variant="icon"
                onPress={() => {
                  router.back();
                }}
                style={styles.backBtn}
              >
                <BackArrowIcon size={20} color={theme.colors.text} />
              </IconButton>
              <Text style={[styles.headerTitle, { color: theme.colors.text }, { pointerEvents: 'none' }]}>{t('New post')}</Text>
              <View style={styles.headerIcons}>
                <IconButton variant="icon"
                  style={styles.iconBtn}
                  onPress={() => setShowModeToggle(!showModeToggle)}
                >
                  {showModeToggle ? (
                    <HideIcon size={20} color={theme.colors.text} />
                  ) : (
                    <ChevronRightIcon size={20} color={theme.colors.text} style={{ transform: [{ rotate: '90deg' }] }} />
                  )}
                </IconButton>
                <IconButton variant="icon"
                  style={styles.iconBtn}
                  onPress={() => {
                    bottomSheet.setBottomSheetContent(
                      <Suspense fallback={null}>
                        <DraftsSheet
                          onClose={() => bottomSheet.openBottomSheet(false)}
                          onLoadDraft={loadDraft}
                          currentDraftId={currentDraftId}
                        />
                      </Suspense>
                    );
                    bottomSheet.openBottomSheet(true);
                  }}
                >
                  <DraftsIcon size={20} color={theme.colors.text} />
                </IconButton>
                <IconButton variant="icon"
                  style={styles.iconBtn}
                  onPress={() => {
                    // Menu icon - show compose options
                    Alert.alert(
                      t('common.options'),
                      '',
                      [
                        {
                          text: t('common.clearAll'),
                          style: 'destructive',
                          onPress: () => {
                            setPostContent('');
                            setMediaIds([]);
                            setPollOptions([]);
                            setPollTitle('');
                            setShowPollCreator(false);
                            setLocation(null);
                            setSources([]);
                            setArticle(null);
                            setArticleDraftTitle('');
                            setArticleDraftBody('');
                            clearAllThreads();
                            setMentions([]);
                            clearSchedule({ silent: true });
                            toast.success(t('common.cleared'));
                          },
                        },
                        {
                          text: t('common.cancel'),
                          style: 'cancel',
                        },
                      ],
                      { cancelable: true }
                    );
                  }}
                >
                  <DotIcon size={20} color={theme.colors.text} />
                </IconButton>
              </View>
            </View>

            {/* Mode Toggle Section */}
            {showModeToggle && (
              <View style={[styles.modeToggleContainer, { backgroundColor: theme.colors.backgroundSecondary, borderBottomColor: theme.colors.border }]}>
                <View style={styles.modeToggleRow}>
                  <View style={styles.modeOption}>
                    <Text style={[styles.modeLabel, postingMode === 'thread' && styles.activeModeLabel, { color: theme.colors.text }]}>
                      {t('Thread')}
                    </Text>
                    <Text style={[styles.modeDescription, { color: theme.colors.textSecondary }]}>
                      {t('Post as linked thread')}
                    </Text>
                  </View>
                  <Toggle
                    value={postingMode === 'beast'}
                    onValueChange={(value) => setPostingMode(value ? 'beast' : 'thread')}
                    containerStyle={styles.modeToggle}
                  />
                  <View style={styles.modeOption}>
                    <Text style={[styles.modeLabel, postingMode === 'beast' && styles.activeModeLabel, { color: theme.colors.text }]}>
                      {t('Beast')}
                    </Text>
                    <Text style={[styles.modeDescription, { color: theme.colors.textSecondary }]}>
                      {t('Post all at once')}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Main composer and thread section */}
            <View style={styles.threadContainer}>
              {/* Continuous timeline line for all items - from composer to add button */}
              <View style={[styles.continuousTimelineLine, { left: TIMELINE_LINE_OFFSET }]} />

              {/* Main composer */}
              <View style={styles.postContainer}>
                <View style={styles.composerWithTimeline}>
                  <PostHeader
                    paddingHorizontal={HPAD}
                    user={{
                      name: user?.name?.full || user?.username || '',
                      handle: user?.username || '',
                      verified: Boolean(user?.verified)
                    }}
                    avatarUri={user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined}
                    avatarSize={AVATAR_SIZE}
                    onPressUser={() => { }}
                    onPressAvatar={() => { }}
                  >
                    <MentionTextInput
                      ref={mainTextInputRef}
                      style={[styles.mainTextInput, { color: theme.colors.text }]}
                      placeholder={t("What's new?")}
                      value={postContent}
                      onChangeText={setPostContent}
                      onMentionsChange={setMentions}
                      multiline
                      autoFocus
                    />
                  </PostHeader>

                  {/* Attachments row (poll + article + media + link) */}
                  {attachmentOrder.length > 0 ? (
                    <View style={[styles.timelineForeground, styles.mediaPreviewContainer]}
                    >
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={[styles.mediaPreviewScroll, { paddingLeft: BOTTOM_LEFT_PAD }]}
                      >
                        {attachmentOrder.map((key, index) => {
                          const total = attachmentOrder.length;
                          const canMoveLeft = index > 0;
                          const canMoveRight = index < total - 1;

                          if (key === POLL_ATTACHMENT_KEY) {
                            if (!showPollCreator) return null;
                            return (
                              <View key={key} style={styles.pollAttachmentWrapper}>
                                {total > 1 ? (
                                  <View style={[styles.mediaReorderControls, { pointerEvents: 'box-none' }]}>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(POLL_ATTACHMENT_KEY, 'left')}
                                      disabled={!canMoveLeft}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveLeft && styles.mediaReorderButtonDisabled]}
                                    >
                                      <BackArrowIcon size={14} color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(POLL_ATTACHMENT_KEY, 'right')}
                                      disabled={!canMoveRight}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveRight && styles.mediaReorderButtonDisabled]}
                                    >
                                      <ChevronRightIcon size={14} color={!canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                  </View>
                                ) : null}
                                <TouchableOpacity
                                  style={[styles.pollAttachmentCard, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                                  activeOpacity={0.85}
                                  onPress={focusPollCreator}
                                >
                                  <View style={styles.pollAttachmentHeader}>
                                    <View style={[styles.pollAttachmentBadge, { backgroundColor: theme.colors.background }]}
                                    >
                                      <PollIcon size={16} color={theme.colors.primary} />
                                      <Text style={[styles.pollAttachmentBadgeText, { color: theme.colors.primary }]}>
                                        {t('compose.poll.title', { defaultValue: 'Poll' })}
                                      </Text>
                                    </View>
                                    <Text style={[styles.pollAttachmentMeta, { color: theme.colors.textSecondary }]}>
                                      {t('compose.poll.optionCount', {
                                        count: pollOptions.length,
                                        defaultValue:
                                          pollOptions.length === 0
                                            ? 'No options yet'
                                            : pollOptions.length === 1
                                              ? '1 option'
                                              : `${pollOptions.length} options`
                                      })}
                                    </Text>
                                  </View>
                                  <Text style={[styles.pollAttachmentQuestion, { color: theme.colors.text }]} numberOfLines={2}>
                                    {pollTitle.trim() || t('compose.poll.placeholderQuestion', { defaultValue: 'Ask a question...' })}
                                  </Text>
                                  <View style={styles.pollAttachmentOptions}>
                                    {(pollOptions.length > 0 ? pollOptions : ['', '']).slice(0, 2).map((option, optionIndex) => {
                                      const trimmed = option?.trim?.() || '';
                                      return (
                                        <View
                                          key={`poll-opt-${optionIndex}`}
                                          style={[styles.pollAttachmentOption, { borderColor: theme.colors.border, backgroundColor: theme.colors.background }]}
                                        >
                                          <Text style={[styles.pollAttachmentOptionText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                            {trimmed || t('compose.poll.optionPlaceholder', { defaultValue: `Option ${optionIndex + 1}` })}
                                          </Text>
                                        </View>
                                      );
                                    })}
                                    {pollOptions.length > 2 ? (
                                      <Text style={[styles.pollAttachmentMore, { color: theme.colors.textTertiary }]}>
                                        {t('compose.poll.moreOptions', { count: pollOptions.length - 2, defaultValue: `+${pollOptions.length - 2} more` })}
                                      </Text>
                                    ) : null}
                                  </View>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  onPress={removePoll}
                                  style={[styles.pollAttachmentRemoveButton, { backgroundColor: theme.colors.background }]}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                  <CloseIcon size={16} color={theme.colors.text} />
                                </TouchableOpacity>
                              </View>
                            );
                          }

                          if (key === ARTICLE_ATTACHMENT_KEY) {
                            if (!(hasArticleContent && article)) return null;
                            return (
                              <View
                                key={key}
                                style={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                              >
                                {total > 1 ? (
                                  <View style={[styles.mediaReorderControls, { pointerEvents: 'box-none' }]}>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(ARTICLE_ATTACHMENT_KEY, 'left')}
                                      disabled={!canMoveLeft}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveLeft && styles.mediaReorderButtonDisabled]}
                                    >
                                      <BackArrowIcon size={14} color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(ARTICLE_ATTACHMENT_KEY, 'right')}
                                      disabled={!canMoveRight}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveRight && styles.mediaReorderButtonDisabled]}
                                    >
                                      <ChevronRightIcon size={14} color={!canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                  </View>
                                ) : null}
                                <PostArticlePreview
                                  title={article.title}
                                  body={article.body}
                                  onPress={openArticleEditor}
                                  style={styles.articleAttachmentPreview}
                                />
                                <TouchableOpacity
                                  onPress={(event) => {
                                    event.stopPropagation();
                                    removeArticle();
                                  }}
                                  style={[styles.articleAttachmentRemoveButton, { backgroundColor: theme.colors.background }]}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                  <CloseIcon size={16} color={theme.colors.text} />
                                </TouchableOpacity>
                              </View>
                            );
                          }

                          if (key === EVENT_ATTACHMENT_KEY) {
                            if (!(hasEventContent && event)) return null;
                            return (
                              <View
                                key={key}
                                style={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                              >
                                {total > 1 ? (
                                  <View style={[styles.mediaReorderControls, { pointerEvents: 'box-none' }]}>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(EVENT_ATTACHMENT_KEY, 'left')}
                                      disabled={!canMoveLeft}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveLeft && styles.mediaReorderButtonDisabled]}
                                    >
                                      <BackArrowIcon size={14} color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(EVENT_ATTACHMENT_KEY, 'right')}
                                      disabled={!canMoveRight}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveRight && styles.mediaReorderButtonDisabled]}
                                    >
                                      <ChevronRightIcon size={14} color={!canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                  </View>
                                ) : null}
                                <PostAttachmentEvent
                                  name={event.name}
                                  date={event.date}
                                  location={event.location}
                                  onPress={openEventEditor}
                                  style={styles.articleAttachmentPreview}
                                />
                                <TouchableOpacity
                                  onPress={(event) => {
                                    event.stopPropagation();
                                    removeEvent();
                                  }}
                                  style={[styles.articleAttachmentRemoveButton, { backgroundColor: theme.colors.background }]}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                  <CloseIcon size={16} color={theme.colors.text} />
                                </TouchableOpacity>
                              </View>
                            );
                          }

                          if (key === LINK_ATTACHMENT_KEY) {
                            if (detectedLinks.length === 0) return null;
                            const link = detectedLinks[0];
                            return (
                              <View
                                key={key}
                                style={[styles.linkAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                              >
                                {total > 1 ? (
                                  <View style={[styles.mediaReorderControls, { pointerEvents: 'box-none' }]}>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(LINK_ATTACHMENT_KEY, 'left')}
                                      disabled={!canMoveLeft}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveLeft && styles.mediaReorderButtonDisabled]}
                                    >
                                      <BackArrowIcon size={14} color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(LINK_ATTACHMENT_KEY, 'right')}
                                      disabled={!canMoveRight}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveRight && styles.mediaReorderButtonDisabled]}
                                    >
                                      <ChevronRightIcon size={14} color={!canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                  </View>
                                ) : null}
                                <LinkPreview
                                  link={link}
                                />
                                <TouchableOpacity
                                  onPress={() => {
                                    // Remove link by clearing the URL from text
                                    const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
                                    const newContent = postContent.replace(urlPattern, '').trim();
                                    setPostContent(newContent);
                                  }}
                                  style={[styles.mediaRemoveButton, { backgroundColor: theme.colors.background }]}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                  <CloseIcon size={16} color={theme.colors.text} />
                                </TouchableOpacity>
                              </View>
                            );
                          }

                          if (isMediaAttachmentKey(key)) {
                            const mediaId = getMediaIdFromAttachmentKey(key);
                            const mediaItem = mediaIds.find(m => m.id === mediaId);
                            if (!mediaItem) return null;
                            const mediaUrl = oxyServices.getFileDownloadUrl(mediaItem.id);
                            return (
                              <View
                                key={key}
                                style={[styles.mediaPreviewItem, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
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
                                {total > 1 ? (
                                  <View style={[styles.mediaReorderControls, { pointerEvents: 'box-none' }]}>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(key, 'left')}
                                      disabled={!canMoveLeft}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveLeft && styles.mediaReorderButtonDisabled]}
                                    >
                                      <BackArrowIcon size={14} color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      onPress={() => moveAttachment(key, 'right')}
                                      disabled={!canMoveRight}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, !canMoveRight && styles.mediaReorderButtonDisabled]}
                                    >
                                      <ChevronRightIcon size={14} color={!canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                  </View>
                                ) : null}
                                <TouchableOpacity
                                  onPress={() => removeMedia(mediaItem.id)}
                                  style={[styles.mediaRemoveButton, { backgroundColor: theme.colors.background }]}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                  <CloseIcon size={16} color={theme.colors.text} />
                                </TouchableOpacity>
                              </View>
                            );
                          }

                          return null;
                        })}
                      </ScrollView>
                    </View>
                  ) : null}

                  <View style={styles.toolbarWrapper}>
                    <ComposeToolbar
                      onMediaPress={openMediaPicker}
                      onPollPress={focusPollCreator}
                      onLocationPress={requestLocation}
                      onGifPress={() => {
                        bottomSheet.setBottomSheetContent(
                          <Suspense fallback={null}>
                            <GifPickerSheet
                              onClose={() => bottomSheet.openBottomSheet(false)}
                              onSelectGif={async (gifUrl: string, gifId: string) => {
                              try {
                                const mediaItem: ComposerMediaItem = { id: gifId, type: 'gif' };
                                setMediaIds(prev => prev.some(m => m.id === gifId) ? prev : [...prev, mediaItem]);
                                toast.success(t('GIF attached'));
                              } catch (error: any) {
                                toast.error(error?.message || t('Failed to attach GIF'));
                              }
                            }}
                            />
                          </Suspense>
                        );
                        bottomSheet.openBottomSheet(true);
                      }}
                      onEmojiPress={() => {
                        bottomSheet.setBottomSheetContent(
                          <Suspense fallback={null}>
                            <EmojiPickerSheet
                              onClose={() => bottomSheet.openBottomSheet(false)}
                              onSelectEmoji={(emoji: string) => {
                                mainTextInputRef.current?.insertTextAtCursor(emoji);
                              }}
                            />
                          </Suspense>
                        );
                        bottomSheet.openBottomSheet(true);
                      }}
                      onSchedulePress={handleSchedulePress}
                      onSourcesPress={openSourcesSheet}
                      onArticlePress={openArticleEditor}
                      onEventPress={openEventEditor}
                      hasLocation={!!location}
                      isGettingLocation={isGettingLocation}
                      hasPoll={showPollCreator}
                      hasMedia={mediaIds.length > 0}
                      hasSources={sources.length > 0}
                      hasArticle={hasArticleContent}
                      hasEvent={hasEventContent}
                      hasSchedule={Boolean(scheduledAt)}
                      scheduleEnabled={scheduleEnabled}
                      hasSourceErrors={invalidSources}
                      disabled={isPosting}
                    />
                    {postContent.length > 0 && (
                      <Text style={[styles.characterCountText, { color: theme.colors.textSecondary }]}>
                        {postContent.length}
                      </Text>
                    )}
                  </View>

                  {scheduledAt && (
                    <View
                      style={[
                        styles.scheduleInfoContainer,
                        {
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.backgroundSecondary,
                        }
                      ]}
                    >
                      <CalendarIcon size={14} color={theme.colors.primary} />
                      <Text style={[styles.scheduleInfoText, { color: theme.colors.text }]}
                      >
                        {t('compose.schedule.set', {
                          defaultValue: 'Scheduled for {{time}}',
                          time: formatScheduledLabel(scheduledAt)
                        })}
                      </Text>
                      <TouchableOpacity onPress={() => clearSchedule()} style={styles.scheduleInfoClearButton}>
                        <Text style={[styles.scheduleInfoClearText, { color: theme.colors.primary }]}>{t('compose.schedule.clear', { defaultValue: 'Clear' })}</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* Poll Creator */}
                  {showPollCreator && (
                    <PollCreator
                      pollTitle={pollTitle}
                      onTitleChange={setPollTitle}
                      pollOptions={pollOptions}
                      onAddOption={addPollOption}
                      onOptionChange={updatePollOption}
                      onRemoveOption={removePollOption}
                      onRemove={removePoll}
                      style={{ marginLeft: BOTTOM_LEFT_PAD }}
                    />
                  )}

                  {/* Location Display */}
                  {location && (
                    <LocationDisplay
                      location={location}
                      onRemove={removeLocation}
                      style={{ marginLeft: BOTTOM_LEFT_PAD }}
                    />
                  )}
                </View>
              </View>

              {/* Thread items */}
              {threadItems.map((item, _index) => (
                <View key={`thread-${item.id}`} style={styles.postContainer}>
                  <View style={styles.threadItemWithTimeline}>
                    <View style={[styles.headerRow, { paddingHorizontal: HPAD }]}>
                      <TouchableOpacity activeOpacity={0.7}>
                        <Avatar
                          source={user?.avatar ? { uri: oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') } : undefined}
                          size={40}
                          verified={Boolean(user?.verified)}
                          style={{ marginRight: 12 }}
                        />
                      </TouchableOpacity>
                      <View style={styles.headerMeta}>
                        <View style={styles.headerChildren}>
                          <MentionTextInput
                            ref={(el) => { threadTextInputRefs.current[item.id] = el; }}
                            style={styles.threadTextInput}
                            placeholder={t('Say more...')}
                            value={item.text}
                            onChangeText={(v) => updateThreadText(item.id, v)}
                            onMentionsChange={(m) => updateThreadMentions(item.id, m)}
                            multiline
                          />
                          <View style={styles.toolbarWrapper}>
                            <ComposeToolbar
                              onMediaPress={() => openThreadMediaPicker(item.id)}
                              onPollPress={() => openThreadPollCreator(item.id)}
                              onLocationPress={() => requestThreadLocation(item.id)}
                              onGifPress={() => {
                                const currentThreadId = item.id;
                                bottomSheet.setBottomSheetContent(
                                  <Suspense fallback={null}>
                                    <GifPickerSheet
                                      onClose={() => bottomSheet.openBottomSheet(false)}
                                      onSelectGif={async (gifUrl: string, gifId: string) => {
                                        try {
                                          const mediaItem: ComposerMediaItem = { id: gifId, type: 'gif' };
                                          addThreadMedia(currentThreadId, mediaItem);
                                          toast.success(t('GIF attached'));
                                        } catch (error: any) {
                                          toast.error(error?.message || t('Failed to attach GIF'));
                                        }
                                      }}
                                    />
                                  </Suspense>
                                );
                                bottomSheet.openBottomSheet(true);
                              }}
                              onEmojiPress={() => {
                                const currentThreadId = item.id;
                                bottomSheet.setBottomSheetContent(
                                  <Suspense fallback={null}>
                                    <EmojiPickerSheet
                                      onClose={() => bottomSheet.openBottomSheet(false)}
                                      onSelectEmoji={(emoji: string) => {
                                        threadTextInputRefs.current[currentThreadId]?.insertTextAtCursor(emoji);
                                      }}
                                    />
                                  </Suspense>
                                );
                                bottomSheet.openBottomSheet(true);
                              }}
                              hasLocation={!!item.location}
                              hasPoll={item.showPollCreator}
                              hasMedia={item.mediaIds.length > 0}
                              disabled={isPosting}
                            />
                            {item.text.length > 0 && (
                              <Text style={[styles.characterCountText, { color: theme.colors.textSecondary }]}>
                                {item.text.length}
                              </Text>
                            )}
                          </View>
                          <TouchableOpacity
                            style={styles.removeThreadBtn}
                            onPress={() => removeThread(item.id)}
                          >
                            <CloseIcon size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>

                    {/* Thread item attachments row */}
                    {(item.showPollCreator || item.mediaIds.length > 0) && (
                      <View style={[styles.timelineForeground, styles.mediaPreviewContainer]}
                      >
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={[styles.mediaPreviewScroll, { paddingLeft: BOTTOM_LEFT_PAD }]}
                        >
                          {item.showPollCreator ? (
                            <View style={styles.pollAttachmentWrapper}>
                              <TouchableOpacity
                                style={[styles.pollAttachmentCard, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                                activeOpacity={0.85}
                                onPress={() => {
                                  openThreadPollCreator(item.id);
                                  setTimeout(() => {
                                    threadPollTitleRefs.current[item.id]?.focus();
                                  }, 50);
                                }}
                              >
                                <View style={styles.pollAttachmentHeader}>
                                  <View style={[styles.pollAttachmentBadge, { backgroundColor: theme.colors.background }]}
                                  >
                                    <PollIcon size={16} color={theme.colors.primary} />
                                    <Text style={[styles.pollAttachmentBadgeText, { color: theme.colors.primary }]}>
                                      {t('compose.poll.title', { defaultValue: 'Poll' })}
                                    </Text>
                                  </View>
                                  <Text style={[styles.pollAttachmentMeta, { color: theme.colors.textSecondary }]}>
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
                                <Text style={[styles.pollAttachmentQuestion, { color: theme.colors.text }]} numberOfLines={2}>
                                  {item.pollTitle?.trim() || t('compose.poll.placeholderQuestion', { defaultValue: 'Ask a question...' })}
                                </Text>
                                <View style={styles.pollAttachmentOptions}>
                                  {(item.pollOptions.length > 0 ? item.pollOptions : ['', '']).slice(0, 2).map((option, index) => {
                                    const trimmed = option?.trim?.() || '';
                                    return (
                                      <View
                                        key={`thread-${item.id}-poll-opt-${index}`}
                                        style={[styles.pollAttachmentOption, { borderColor: theme.colors.border, backgroundColor: theme.colors.background }]}
                                      >
                                        <Text style={[styles.pollAttachmentOptionText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
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
                                onPress={() => removeThreadPoll(item.id)}
                                style={[styles.pollAttachmentRemoveButton, { backgroundColor: theme.colors.background }]}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                              >
                                <CloseIcon size={16} color={theme.colors.text} />
                              </TouchableOpacity>
                            </View>
                          ) : null}
                          {item.mediaIds.map((mediaItem, mediaIndex) => {
                            const mediaUrl = oxyServices.getFileDownloadUrl(mediaItem.id);
                            const mediaCount = item.mediaIds.length;
                            return (
                              <View
                                key={mediaItem.id}
                                style={[styles.mediaPreviewItem, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
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
                                  <View style={[styles.mediaReorderControls, { pointerEvents: 'box-none' }]}>
                                    <TouchableOpacity
                                      onPress={() => moveThreadMedia(item.id, mediaItem.id, 'left')}
                                      disabled={mediaIndex === 0}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, mediaIndex === 0 && styles.mediaReorderButtonDisabled]}
                                    >
                                      <BackArrowIcon size={14} color={mediaIndex === 0 ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      onPress={() => moveThreadMedia(item.id, mediaItem.id, 'right')}
                                      disabled={mediaIndex === mediaCount - 1}
                                      style={[styles.mediaReorderButton, { backgroundColor: theme.colors.background }, mediaIndex === mediaCount - 1 && styles.mediaReorderButtonDisabled]}
                                    >
                                      <ChevronRightIcon size={14} color={mediaIndex === mediaCount - 1 ? theme.colors.textTertiary : theme.colors.textSecondary} />
                                    </TouchableOpacity>
                                  </View>
                                ) : null}
                                <TouchableOpacity
                                  onPress={() => removeThreadMedia(item.id, mediaItem.id)}
                                  style={[styles.mediaRemoveButton, { backgroundColor: theme.colors.background }]}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                  <CloseIcon size={16} color={theme.colors.text} />
                                </TouchableOpacity>
                              </View>
                            );
                          })}
                        </ScrollView>
                      </View>
                    )}

                    {/* Thread item poll creator */}
                    {item.showPollCreator && (
                      <PollCreator
                        pollTitle={item.pollTitle || ''}
                        onTitleChange={(value) => updateThreadPollTitle(item.id, value)}
                        pollOptions={item.pollOptions}
                        onOptionChange={(index, value) => updateThreadPollOption(item.id, index, value)}
                        onAddOption={() => addThreadPollOption(item.id)}
                        onRemoveOption={(index) => removeThreadPollOption(item.id, index)}
                        onRemove={() => removeThreadPoll(item.id)}
                        style={{ marginLeft: BOTTOM_LEFT_PAD }}
                      />
                    )}

                    {/* Thread item location display */}
                    {item.location && (
                      <LocationDisplay
                        location={item.location}
                        onRemove={() => removeThreadLocation(item.id)}
                        style={{ marginLeft: BOTTOM_LEFT_PAD }}
                      />
                    )}
                  </View>
                </View>
              ))}

              {/* Add thread/post button */}
              <TouchableOpacity
                style={styles.postContainer}
                onPress={addThread}
              >
                <View style={[styles.headerRow, { paddingHorizontal: HPAD }]}>
                  <TouchableOpacity activeOpacity={0.7}>
                    <Avatar
                      source={user?.avatar ? { uri: oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') } : undefined}
                      size={40}
                      verified={Boolean(user?.verified)}
                      style={{ marginRight: 12 }}
                    />
                  </TouchableOpacity>
                  <View style={styles.headerMeta}>
                    <View style={styles.headerChildren}>
                      <Text style={styles.addToThreadText}>
                        {postingMode === 'thread' ? t('Add to thread') : t('Add another post')}
                      </Text>
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            </View>

            <View style={styles.bottomBar}>
              <TouchableOpacity onPress={openReplySettings} activeOpacity={0.7}>
                <Text style={styles.bottomText}>{getReplyPermissionText()}</Text>
              </TouchableOpacity>
            </View>
          </ThemedView>
        </KeyboardAvoidingView>

        {/* Floating post button */}
        <TouchableOpacity
          onPress={handlePost}
          disabled={!isPostButtonEnabled}
          style={[
            styles.floatingPostButton,
            { backgroundColor: theme.colors.primary },
            !isPostButtonEnabled && [styles.floatingPostButtonDisabled, { backgroundColor: theme.colors.border }]
          ]}
        >
          {isPosting ? (
            <Loading variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <Text style={[isPostButtonEnabled ? styles.floatingPostTextDark : styles.floatingPostText, { color: theme.colors.card }]}>{t('Post')}</Text>
          )}
        </TouchableOpacity>

        <ArticleEditor
          visible={isArticleEditorVisible}
          title={articleDraftTitle}
          body={articleDraftBody}
          onTitleChange={setArticleDraftTitle}
          onBodyChange={setArticleDraftBody}
          onClose={closeArticleEditor}
          onSave={handleArticleSave}
        />
        <EventEditor
          visible={isEventEditorVisible}
          name={eventDraftName}
          date={eventDraftDate}
          location={eventDraftLocation}
          description={eventDraftDescription}
          onNameChange={setEventDraftName}
          onDateChange={setEventDraftDate}
          onLocationChange={setEventDraftLocation}
          onDescriptionChange={setEventDraftDescription}
          onClose={closeEventEditor}
          onSave={handleEventSave}
        />
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 48,
    // keep header clean (no divider)
  },
  cancelButton: {
    padding: 8,
  },
  cancelText: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  postButton: {
    backgroundColor: colors.primaryColor,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 60,
    alignItems: 'center',
  },
  postButtonDisabled: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_5,
  },
  postButtonText: {
    color: colors.COLOR_BLACK_LIGHT_9,
    fontSize: 16,
    fontWeight: '600',
  },
  composeArea: {
    flex: 1,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  userHandle: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginTop: 2,
  },
  textInput: {
    flex: 1,
    fontSize: 18,
    lineHeight: 24,
    color: colors.COLOR_BLACK_LIGHT_1,
    minHeight: 120,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  mediaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
  },
  mediaButton: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mediaButtonText: {
    color: colors.COLOR_BLACK_LIGHT_3,
    fontWeight: '600',
  },
  mediaInfoText: {
    color: colors.COLOR_BLACK_LIGHT_4,
    fontSize: 12,
  },
  previewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 10,
  },
  previewItem: {
    width: 64,
    height: 64,
  },
  removeBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.busy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* header and icon tweaks */
  headerTitle: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    color: colors.COLOR_BLACK_LIGHT_1,
    pointerEvents: 'none', // Don't block touches on buttons
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  iconBtn: {
    marginLeft: 8,
  },
  backBtn: {
    marginRight: 6,
  },

  /* bottom bar and floating post button */
  bottomBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bottomText: {
    color: colors.COLOR_BLACK_LIGHT_4,
    fontSize: 16,
    flex: 1,
  },
  floatingPostButton: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    backgroundColor: '#fff',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 16,
    boxShadow: '0px 0px 6px 0px rgba(0, 0, 0, 0.2)',
    elevation: 6,
  },
  floatingPostButtonDisabled: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_5,
    opacity: 0.7,
  },
  floatingPostText: {
    color: colors.COLOR_BLACK_LIGHT_1,
    fontSize: 16,
    fontWeight: '700',
  },
  floatingPostTextDark: {
    color: '#000',
    fontWeight: '700',
    fontSize: 16,
  },
  /* compose toolbar */
  toolbarDividerArea: {
    width: 28,
    alignItems: 'center',
  },
  toolbarDivider: {
    width: 1,
    height: 48,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 2,
  },
  toolbarIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingLeft: 8,
  },
  smallThreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 8,
  },
  smallThreadText: {
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  // New styles for exact screenshot match
  mainComposer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    gap: 12,
  },
  composerLeftCol: {
    width: 48,
    alignItems: 'center',
  },
  connector: {
    width: 2,
    flex: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
    marginTop: 0,
    borderRadius: 1,
    minHeight: 24,
  },
  mainTextInput: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_1,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  toolbarWrapper: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  characterCountText: {
    fontSize: 12,
    fontWeight: '500',
    marginLeft: 12,
  },
  addToThreadBtn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  addToThreadContent: {
    flex: 1,
    paddingTop: 8,
  },
  addToThreadText: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  // Post component structure styles
  postContainer: {
    flexDirection: 'column',
    gap: 12,
    paddingVertical: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  headerMeta: {
    flex: 1,
    paddingTop: 2,
    gap: 8,
  },
  headerChildren: {
  },
  avatarContainer: {
    alignItems: 'center',
    marginRight: 12, // AVATAR_GAP
  },
  timelineConnector: {
    position: 'absolute',
    left: -32, // Position relative to headerMeta to align with avatar center
    top: -20,
    width: 2,
    height: 32,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 1,
  },
  // Media section styles (from PostMiddle)
  mediaSection: {
    // paddingLeft applied dynamically with BOTTOM_LEFT_PAD
  },
  mediaScroller: {
    paddingRight: 12,
    gap: 12,
  },
  mediaItemContainer: {
    position: 'relative',
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 10,
    width: 280,
    height: 180,
  },
  mediaImage: {
    width: 280,
    height: 180,
    backgroundColor: '#EFEFEF',
    borderRadius: 10,
  },
  mediaRemoveBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaMoreBtn: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  threadTextInput: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_1,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  removeThreadBtn: {
    position: 'absolute',
    top: 0,
    right: 0,
    padding: 6,
  },
  // Timeline connector styles
  threadContainer: {
    position: 'relative',
  },
  continuousTimelineLine: {
    position: 'absolute',
    left: 0,
    top: 20, // Start at center of main composer avatar (20px from top of PostHeader avatar)
    bottom: 20, // End at center of add button avatar (20px from bottom)
    width: 2,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 1,
    zIndex: -1, // Behind the avatars
  },
  composerWithTimeline: {
    position: 'relative',
    zIndex: 2, // Above the timeline line
  },
  threadItemWithTimeline: {
    position: 'relative',
    zIndex: 2, // Above the timeline line
  },
  // Article attachment styles (still used in main compose)
  articleAttachmentWrapper: {
    position: 'relative',
    alignSelf: 'flex-start',
    width: MEDIA_CARD_WIDTH,
    height: MEDIA_CARD_HEIGHT,
    borderRadius: 15,
    borderWidth: 1,
    overflow: 'hidden',
  },
  articleAttachmentRemoveButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  articleAttachmentPreview: {
    flex: 1,
    width: '100%',
    height: '100%',
    padding: 16,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
  },
  // Poll attachment card styles (for thread items)
  pollAttachmentWrapper: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  pollAttachmentCard: {
    width: MEDIA_CARD_WIDTH,
    minHeight: 150,
    borderRadius: 15,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  pollAttachmentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pollAttachmentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pollAttachmentBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  pollAttachmentMeta: {
    fontSize: 12,
    fontWeight: '500',
  },
  pollAttachmentQuestion: {
    fontSize: 16,
    fontWeight: '700',
  },
  pollAttachmentOptions: {
    gap: 8,
  },
  pollAttachmentOption: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pollAttachmentOptionText: {
    fontSize: 13,
    fontWeight: '500',
  },
  pollAttachmentMore: {
    fontSize: 12,
    fontWeight: '500',
  },
  pollAttachmentRemoveButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  // Media preview styles
  mediaPreviewContainer: {
    marginTop: 12,
    width: '100%',
    overflow: 'visible',
  },
  timelineForeground: {
    position: 'relative',
    zIndex: 2,
  },
  mediaPreviewScroll: {
    paddingRight: 12,
    gap: 12,
  },
  mediaPreviewItem: {
    width: MEDIA_CARD_WIDTH,
    height: MEDIA_CARD_HEIGHT,
    borderRadius: 15,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  mediaPreviewImage: {
    width: '100%',
    height: '100%',
  },
  mediaRemoveButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  mediaReorderControls: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 2,
  },
  mediaReorderButton: {
    borderRadius: 999,
    padding: 6,
  },
  mediaReorderButtonDisabled: {
    opacity: 0.4,
  },
  // Link attachment styles
  linkAttachmentWrapper: {
    position: 'relative',
    alignSelf: 'flex-start',
    width: MEDIA_CARD_WIDTH,
    borderRadius: 15,
    borderWidth: 1,
    overflow: 'hidden',
  },
  // Mode toggle styles
  modeToggleContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  modeToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modeOption: {
    flex: 1,
    alignItems: 'center',
  },
  modeLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.COLOR_BLACK_LIGHT_4,
    marginBottom: 2,
  },
  activeModeLabel: {
    color: colors.primaryColor,
  },
  modeDescription: {
    fontSize: 12,
    color: colors.COLOR_BLACK_LIGHT_5,
    textAlign: 'center',
  },
  modeToggle: {
    marginHorizontal: 20,
  },
  scheduleInfoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  scheduleInfoText: {
    flex: 1,
    fontSize: 13,
  },
  scheduleInfoClearButton: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  scheduleInfoClearText: {
    fontSize: 12,
    fontWeight: '600',
  },
  scheduleSheetContainer: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
    gap: 16,
  },
  scheduleSheetTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  scheduleSheetSubtitle: {
    fontSize: 13,
  },
  scheduleSheetDivider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  scheduleOptionButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  scheduleOptionLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  scheduleOptionHint: {
    fontSize: 12,
    marginTop: 4,
  },
  scheduleCustomSection: {
    gap: 12,
  },
  scheduleCustomLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  scheduleCustomInputsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  scheduleCustomInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  scheduleSheetError: {
    fontSize: 12,
  },
  scheduleSheetActionButton: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  scheduleSheetActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  scheduleSheetActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  scheduleSheetSecondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  scheduleSheetSecondaryText: {
    fontSize: 14,
    fontWeight: '500',
  },
});

export default ComposeScreen;
