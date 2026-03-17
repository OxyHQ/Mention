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
import { Ionicons } from '@expo/vector-icons';
import { logger } from '@/utils/logger';
import { useAuth } from '@oxyhq/services';
import { StatusBar } from 'expo-status-bar';
import * as ExpoLocation from 'expo-location';
import { ThemedView } from '@/components/ThemedView';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import Avatar from '@/components/Avatar';
import PostHeader from '@/components/Post/PostHeader';
import PostArticlePreview from '@/components/Post/PostArticlePreview';
import PostAttachmentEvent from '@/components/Post/Attachments/PostAttachmentEvent';
import RoomCard from '@/components/RoomCard';
import ComposeToolbar from '@/components/ComposeToolbar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
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
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { useKeyboardVisibility } from '@/hooks/useKeyboardVisibility';
// Lazy load sheets - only loaded when user opens them
const DraftsSheet = lazy(() => import('@/components/Compose/DraftsSheet'));
const GifPickerSheet = lazy(() => import('@/components/Compose/GifPickerSheet'));
const EmojiPickerSheet = lazy(() => import('@/components/Compose/EmojiPickerSheet'));
const SourcesSheet = lazy(() => import('@/components/Compose/SourcesSheet'));
const ScheduleSheet = lazy(() => import('@/components/Compose/ScheduleSheet'));
const CreateRoomSheet = lazy(() => import('@/components/rooms/CreateRoomSheet'));
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
import { useRoomManager } from '@/hooks/useRoomManager';
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
  AttachmentCarouselItem,
} from '@/components/Compose';
import InteractionSettingsPills from '@/components/Compose/InteractionSettingsPills';
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
  ROOM_ATTACHMENT_KEY,
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
  const { user, showBottomSheet, oxyServices, isAuthenticated } = useAuth();
  const isScreenNotMobile = useIsScreenNotMobile();
  const keyboardVisible = useKeyboardVisibility();
  const bottomBarVisible = isAuthenticated && !isScreenNotMobile && !keyboardVisible;
  const { createPost, createThread } = usePostsStore();
  const { t } = useTranslation();
  const { editPostId } = useLocalSearchParams<{ editPostId?: string }>();
  const [isEditMode, setIsEditMode] = useState(false);
  const [editLoading, setEditLoading] = useState(false);

  // Use custom hooks for state management
  const mediaManager = useMediaManager();
  const pollManager = usePollManager();
  const locationManager = useLocationManager();
  const sourcesManager = useSourcesManager();
  const threadManager = useThreadManager();
  const articleManager = useArticleManager();
  const eventManager = useEventManager();
  const roomManager = useRoomManager();

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
    setThreadSources,
    addThreadSource,
    updateThreadSourceField,
    removeThreadSource,
    setThreadArticle,
    removeThreadArticle,
    setThreadEvent,
    removeThreadEvent,
    setThreadRoom,
    removeThreadRoom,
    setThreadAttachmentOrder,
    addThreadAttachment,
    removeThreadAttachment,
    setThreadReplyPermission,
    setThreadReviewReplies,
    setThreadQuotesDisabled,
    setThreadSensitive,
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
  const {
    room: attachedRoom,
    attachRoom,
    removeRoom,
    hasContent: roomHasContent,
    clearRoom,
  } = roomManager;

  const hasArticleContent = articleHasContent();
  const hasEventContent = eventHasContent();
  const hasRoomContent = roomHasContent();

  // Remaining local state
  const [postContent, setPostContent] = useState('');
  const [mentions, setMentions] = useState<MentionData[]>([]);
  const [isPosting, setIsPosting] = useState(false);
  const [postingMode, setPostingMode] = useState<'thread' | 'beast'>('thread');
  const [replyPermission, setReplyPermission] = useState<ReplyPermission[]>(['anyone']);
  const [reviewReplies, setReviewReplies] = useState(false);
  const [quotesDisabled, setQuotesDisabled] = useState(false);
  const [showModeToggle, setShowModeToggle] = useState(false);
  const [isSensitive, setIsSensitive] = useState(false);
  const [focusedItemId, setFocusedItemId] = useState<string>('main');

  // Thread item article/event editor state
  const [editingThreadArticleId, setEditingThreadArticleId] = useState<string | null>(null);
  const [threadArticleDraftTitle, setThreadArticleDraftTitle] = useState('');
  const [threadArticleDraftBody, setThreadArticleDraftBody] = useState('');
  const [editingThreadEventId, setEditingThreadEventId] = useState<string | null>(null);
  const [threadEventDraftName, setThreadEventDraftName] = useState('');
  const [threadEventDraftDate, setThreadEventDraftDate] = useState('');
  const [threadEventDraftLocation, setThreadEventDraftLocation] = useState('');
  const [threadEventDraftDescription, setThreadEventDraftDescription] = useState('');

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
    hasRoomContent,
    room: attachedRoom,
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

  // Load existing post data when in edit mode
  useEffect(() => {
    if (!editPostId) return;
    let cancelled = false;
    setEditLoading(true);
    setIsEditMode(true);
    (async () => {
      try {
        const post = await feedService.getPostById(editPostId);
        if (cancelled) return;
        // Pre-populate compose fields from existing post
        const postText = post?.content?.text || post?.text || '';
        setPostContent(postText);
        if (post?.content?.media && post.content.media.length > 0) {
          setMediaIds(post.content.media.map((m: any) => ({
            id: m.id || m,
            type: m.type || 'image',
          })));
        }
        if (post?.mentions && post.mentions.length > 0) {
          setMentions(post.mentions.map((m: any) => (typeof m === 'string' ? { id: m, display: m } : m)));
        }
      } catch (e) {
        logger.error('[Compose] Failed to load post for editing', e);
        toast.error(t('Failed to load post for editing'));
      } finally {
        if (!cancelled) setEditLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editPostId]);

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

    if (!(hasText || hasMedia || hasPoll || hasArticleContent || hasEventContent || hasRoomContent)) {
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
        room: attachedRoom,
        hasRoomContent,
        location,
        formattedSources,
        attachmentOrder: attachmentOrderRef.current || attachmentOrder,
        replyPermission,
        reviewReplies,
        quotesDisabled,
        scheduledAt: scheduledAtRef.current,
        isSensitive,
      });
      allPosts.push(mainPost);

      // Add thread items if any
      threadItems.forEach(item => {
        if (shouldIncludeThreadItem(item)) {
          const threadPost = buildThreadPost(item);
          allPosts.push(threadPost);
        }
      });

      // Send to backend
      if (isEditMode && editPostId) {
        // Edit mode: update existing post
        const editData = {
          content: {
            text: postContent,
            media: mediaIds.map(m => ({ id: m.id, type: m.type })),
          },
          hashtags: mainPost.hashtags || [],
          mentions: mainPost.mentions || [],
        };
        await feedService.editPost(editPostId, editData);
      } else if (allPosts.length === 1) {
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

      const successMessage = isEditMode
        ? t('Post updated successfully')
        : wasScheduled && scheduledAtValue
          ? t('compose.schedule.success', { defaultValue: 'Post scheduled for {{time}}', time: formatScheduledLabel(scheduledAtValue) })
          : t('Post published successfully');
      toast.success(successMessage);

      clearSchedule({ silent: true });
      clearArticle();
      clearEvent();
      clearRoom();

      // Navigate back after posting
      router.back();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[Compose] Failed to publish post', message);
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

  const anyoneCanInteract = replyPermission.includes('anyone') && !quotesDisabled;
  const interactionLabel = anyoneCanInteract
    ? t('Anyone can interact')
    : t('Interaction limited');

  const [isReplySettingsOpen, setIsReplySettingsOpen] = useState(false);

  // Wrapper for openScheduleSheet to pass ScheduleSheet component
  const handleSchedulePress = useCallback(() => {
    openScheduleSheet(ScheduleSheet);
  }, [openScheduleSheet]);

  // Thread item article editor helpers
  const openThreadArticleEditor = useCallback((threadId: string) => {
    const threadItem = threadItemsRef.current.find(t => t.id === threadId);
    setThreadArticleDraftTitle(threadItem?.article?.title || '');
    setThreadArticleDraftBody(threadItem?.article?.body || '');
    setEditingThreadArticleId(threadId);
  }, [threadItemsRef]);

  const closeThreadArticleEditor = useCallback(() => {
    setEditingThreadArticleId(null);
  }, []);

  const saveThreadArticle = useCallback(() => {
    if (!editingThreadArticleId) return;
    const title = threadArticleDraftTitle.trim();
    const body = threadArticleDraftBody.trim();
    if (!title && !body) {
      setThreadArticle(editingThreadArticleId, null);
    } else {
      setThreadArticle(editingThreadArticleId, { title, body });
    }
    setEditingThreadArticleId(null);
  }, [editingThreadArticleId, threadArticleDraftTitle, threadArticleDraftBody, setThreadArticle]);

  // Thread item event editor helpers
  const openThreadEventEditor = useCallback((threadId: string) => {
    const threadItem = threadItemsRef.current.find(t => t.id === threadId);
    setThreadEventDraftName(threadItem?.event?.name || '');
    setThreadEventDraftDate(threadItem?.event?.date || new Date().toISOString());
    setThreadEventDraftLocation(threadItem?.event?.location || '');
    setThreadEventDraftDescription(threadItem?.event?.description || '');
    setEditingThreadEventId(threadId);
  }, [threadItemsRef]);

  const closeThreadEventEditor = useCallback(() => {
    setEditingThreadEventId(null);
  }, []);

  const saveThreadEvent = useCallback(() => {
    if (!editingThreadEventId) return;
    const name = threadEventDraftName.trim();
    const date = threadEventDraftDate;
    if (!name) {
      setThreadEvent(editingThreadEventId, null);
    } else {
      setThreadEvent(editingThreadEventId, {
        name,
        date,
        location: threadEventDraftLocation.trim() || undefined,
        description: threadEventDraftDescription.trim() || undefined,
      });
    }
    setEditingThreadEventId(null);
  }, [editingThreadEventId, threadEventDraftName, threadEventDraftDate, threadEventDraftLocation, threadEventDraftDescription, setThreadEvent]);

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
            quotesDisabled={quotesDisabled}
            onQuotesDisabledChange={setQuotesDisabled}
          />
        </Suspense>
      );
    }
  }, [replyPermission, quotesDisabled, isReplySettingsOpen]);

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
          quotesDisabled={quotesDisabled}
          onQuotesDisabledChange={setQuotesDisabled}
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
            <View className="bg-background border-border" style={styles.header}>
              <IconButton variant="icon"
                onPress={() => {
                  router.back();
                }}
                style={styles.backBtn}
              >
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>
              <Text className="text-foreground" style={[styles.headerTitle, { pointerEvents: 'none' }]}>{isEditMode ? t('Edit post') : t('New post')}</Text>
              <View style={styles.headerIcons}>
                <IconButton variant="icon"
                  style={styles.iconBtn}
                  onPress={() => setShowModeToggle(!showModeToggle)}
                >
                  {showModeToggle ? (
                    <HideIcon size={20} className="text-foreground" />
                  ) : (
                    <ChevronRightIcon size={20} className="text-foreground" style={{ transform: [{ rotate: '90deg' }] }} />
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
                  <DraftsIcon size={20} className="text-foreground" />
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
                            clearArticle();
                            clearEvent();
                            clearRoom();
                            clearAllThreads();
                            clearAttachmentOrder();
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
                  <DotIcon size={20} className="text-foreground" />
                </IconButton>
              </View>
            </View>

            {/* Editing indicator */}
            {isEditMode && (
              <View className="px-4 py-2 bg-secondary border-b border-border">
                <Text className="text-primary text-[13px] font-semibold">{editLoading ? t('Loading post...') : t('Editing post - changes must be saved within 30 minutes of creation')}</Text>
              </View>
            )}

            {/* Mode Toggle Section */}
            {showModeToggle && (
              <View className="bg-secondary border-border" style={styles.modeToggleContainer}>
                <View style={styles.modeToggleRow}>
                  <View style={styles.modeOption}>
                    <Text className="text-foreground" style={[styles.modeLabel, postingMode === 'thread' && styles.activeModeLabel]}>
                      {t('Thread')}
                    </Text>
                    <Text className="text-muted-foreground" style={styles.modeDescription}>
                      {t('Post as linked thread')}
                    </Text>
                  </View>
                  <Toggle
                    value={postingMode === 'beast'}
                    onValueChange={(value) => setPostingMode(value ? 'beast' : 'thread')}
                    containerStyle={styles.modeToggle}
                  />
                  <View style={styles.modeOption}>
                    <Text className="text-foreground" style={[styles.modeLabel, postingMode === 'beast' && styles.activeModeLabel]}>
                      {t('Beast')}
                    </Text>
                    <Text className="text-muted-foreground" style={styles.modeDescription}>
                      {t('Post all at once')}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Main composer and thread section */}
            <ScrollView
              style={styles.threadScrollView}
              contentContainerStyle={styles.threadScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
            <View style={styles.threadContainer}>
              {/* Main composer */}
              <View style={[styles.postContainer, focusedItemId !== 'main' && threadItems.length > 0 && styles.unfocusedItem]}>
                {/* Connector line below main avatar */}
                <View style={[styles.itemConnectorLine, { left: TIMELINE_LINE_OFFSET, backgroundColor: `${theme.colors.primary}30` }]} />
                <View style={styles.composerWithTimeline}>
                  <PostHeader
                    paddingHorizontal={HPAD}
                    user={{
                      name: user?.name?.full || user?.username || '',
                      handle: user?.username || '',
                      verified: Boolean(user?.verified)
                    }}
                    avatarUri={user?.avatar}
                    avatarSize={AVATAR_SIZE}
                    onPressUser={() => { }}
                    onPressAvatar={() => { }}
                  >
                    <MentionTextInput
                      ref={mainTextInputRef}
                      className="text-foreground"
                      style={styles.mainTextInput}
                      placeholder={t("What's new?")}
                      value={postContent}
                      onChangeText={setPostContent}
                      onMentionsChange={setMentions}
                      onFocus={() => setFocusedItemId('main')}
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

                          if (key === POLL_ATTACHMENT_KEY) {
                            if (!showPollCreator) return null;
                            return (
                              <AttachmentCarouselItem
                                key={key}
                                attachmentKey={key}
                                index={index}
                                total={total}
                                onMove={moveAttachment}
                                onRemove={removePoll}
                                wrapperStyle={styles.pollAttachmentWrapper}
                              >
                                <TouchableOpacity
                                  className="border-border bg-secondary" style={styles.pollAttachmentCard}
                                  activeOpacity={0.85}
                                  onPress={focusPollCreator}
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
                                  <Text className="text-foreground" style={styles.pollAttachmentQuestion} numberOfLines={2}>
                                    {pollTitle.trim() || t('compose.poll.placeholderQuestion', { defaultValue: 'Ask a question...' })}
                                  </Text>
                                  <View style={styles.pollAttachmentOptions}>
                                    {(pollOptions.length > 0 ? pollOptions : ['', '']).slice(0, 2).map((option, optionIndex) => {
                                      const trimmed = option?.trim?.() || '';
                                      return (
                                        <View
                                          key={`poll-opt-${optionIndex}`}
                                          className="border-border bg-background" style={styles.pollAttachmentOption}
                                        >
                                          <Text className="text-muted-foreground" style={styles.pollAttachmentOptionText} numberOfLines={1}>
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
                              </AttachmentCarouselItem>
                            );
                          }

                          if (key === ARTICLE_ATTACHMENT_KEY) {
                            if (!(hasArticleContent && article)) return null;
                            return (
                              <AttachmentCarouselItem
                                key={key}
                                attachmentKey={key}
                                index={index}
                                total={total}
                                onMove={moveAttachment}
                                onRemove={removeArticle}
                                wrapperStyle={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                              >
                                <PostArticlePreview
                                  title={article.title}
                                  body={article.body}
                                  onPress={openArticleEditor}
                                  style={styles.articleAttachmentPreview}
                                />
                              </AttachmentCarouselItem>
                            );
                          }

                          if (key === EVENT_ATTACHMENT_KEY) {
                            if (!(hasEventContent && event)) return null;
                            return (
                              <AttachmentCarouselItem
                                key={key}
                                attachmentKey={key}
                                index={index}
                                total={total}
                                onMove={moveAttachment}
                                onRemove={removeEvent}
                                wrapperStyle={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                              >
                                <PostAttachmentEvent
                                  name={event.name}
                                  date={event.date}
                                  location={event.location}
                                  onPress={openEventEditor}
                                  style={styles.articleAttachmentPreview}
                                />
                              </AttachmentCarouselItem>
                            );
                          }

                          if (key === ROOM_ATTACHMENT_KEY) {
                            if (!(hasRoomContent && attachedRoom)) return null;
                            return (
                              <AttachmentCarouselItem
                                key={key}
                                attachmentKey={key}
                                index={index}
                                total={total}
                                onMove={moveAttachment}
                                onRemove={removeRoom}
                                wrapperStyle={[styles.articleAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                              >
                                <RoomCard
                                  room={{
                                    _id: attachedRoom.roomId,
                                    title: attachedRoom.title,
                                    status: attachedRoom.status || 'scheduled',
                                    topic: attachedRoom.topic,
                                    participants: [],
                                    host: attachedRoom.host || '',
                                  }}
                                  variant="compact"
                                  style={styles.articleAttachmentPreview}
                                />
                              </AttachmentCarouselItem>
                            );
                          }

                          if (key === LINK_ATTACHMENT_KEY) {
                            if (detectedLinks.length === 0) return null;
                            const link = detectedLinks[0];
                            return (
                              <AttachmentCarouselItem
                                key={key}
                                attachmentKey={key}
                                index={index}
                                total={total}
                                onMove={moveAttachment}
                                onRemove={() => {
                                  const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
                                  const newContent = postContent.replace(urlPattern, '').trim();
                                  setPostContent(newContent);
                                }}
                                wrapperStyle={[styles.linkAttachmentWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
                              >
                                <LinkPreview link={link} />
                              </AttachmentCarouselItem>
                            );
                          }

                          if (isMediaAttachmentKey(key)) {
                            const mediaId = getMediaIdFromAttachmentKey(key);
                            const mediaItem = mediaIds.find(m => m.id === mediaId);
                            if (!mediaItem) return null;
                            const mediaUrl = oxyServices.getFileDownloadUrl(mediaItem.id);
                            return (
                              <AttachmentCarouselItem
                                key={key}
                                attachmentKey={key}
                                index={index}
                                total={total}
                                onMove={moveAttachment}
                                onRemove={() => removeMedia(mediaItem.id)}
                                wrapperStyle={[styles.mediaPreviewItem, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
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
                              </AttachmentCarouselItem>
                            );
                          }

                          return null;
                        })}
                      </ScrollView>
                    </View>
                  ) : null}

                  <View style={styles.toolbarWrapper}>
                    <ComposeToolbar
                      contentPaddingLeft={BOTTOM_LEFT_PAD}
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
                      onRoomPress={() => {
                        bottomSheet.setBottomSheetContent(
                          <Suspense fallback={null}>
                            <CreateRoomSheet
                              onClose={() => bottomSheet.openBottomSheet(false)}
                              mode="embed"
                              onRoomCreated={(createdRoom) => {
                                attachRoom({
                                  roomId: createdRoom._id,
                                  title: createdRoom.title,
                                  status: createdRoom.status,
                                  topic: createdRoom.topic,
                                  host: createdRoom.host,
                                });
                              }}
                            />
                          </Suspense>
                        );
                        bottomSheet.openBottomSheet(true);
                      }}
                      hasLocation={!!location}
                      isGettingLocation={isGettingLocation}
                      hasPoll={showPollCreator}
                      hasMedia={mediaIds.length > 0}
                      hasSources={sources.length > 0}
                      hasArticle={hasArticleContent}
                      hasEvent={hasEventContent}
                      hasRoom={hasRoomContent}
                      hasSchedule={Boolean(scheduledAt)}
                      scheduleEnabled={scheduleEnabled}
                      hasSourceErrors={invalidSources}
                      disabled={isPosting}
                    />
                    {postContent.length > 0 && (
                      <Text className="text-muted-foreground" style={styles.characterCountText}>
                        {postContent.length}
                      </Text>
                    )}
                  </View>

                  {scheduledAt && (
                    <View
                      className="border-border bg-secondary"
                      style={styles.scheduleInfoContainer}
                    >
                      <CalendarIcon size={14} className="text-primary" />
                      <Text className="text-foreground" style={styles.scheduleInfoText}
                      >
                        {t('compose.schedule.set', {
                          defaultValue: 'Scheduled for {{time}}',
                          time: formatScheduledLabel(scheduledAt)
                        })}
                      </Text>
                      <TouchableOpacity onPress={() => clearSchedule()} style={styles.scheduleInfoClearButton}>
                        <Text className="text-primary" style={styles.scheduleInfoClearText}>{t('compose.schedule.clear', { defaultValue: 'Clear' })}</Text>
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

                  {/* Main post interaction settings (beast mode with thread items) */}
                  {postingMode === 'beast' && threadItems.length > 0 && (
                    <View style={{ marginLeft: BOTTOM_LEFT_PAD, paddingHorizontal: HPAD }}>
                      <InteractionSettingsPills
                        replyPermission={replyPermission}
                        quotesDisabled={quotesDisabled}
                        isSensitive={isSensitive}
                        onReplySettingsPress={openReplySettings}
                        onSensitiveToggle={() => setIsSensitive(!isSensitive)}
                      />
                    </View>
                  )}
                </View>
              </View>

              {/* Thread items */}
              {threadItems.map((item, _index) => {
                const itemHasArticle = Boolean(item.article && (item.article.title?.trim() || item.article.body?.trim()));
                const itemHasEvent = Boolean(item.event && item.event.name?.trim());
                const itemHasRoom = Boolean(item.room && item.room.roomId);
                const itemHasSources = item.sources.length > 0 && item.sources.some(s => s.url.trim().length > 0);
                const itemHasAttachments = item.showPollCreator || item.mediaIds.length > 0 || itemHasArticle || itemHasEvent || itemHasRoom || itemHasSources;

                return (
                <View key={`thread-${item.id}`} style={[styles.postContainer, focusedItemId !== item.id && styles.unfocusedItem]}>
                  {/* Connector line above this thread item's avatar */}
                  <View style={[styles.itemConnectorLineAbove, { left: TIMELINE_LINE_OFFSET, backgroundColor: `${theme.colors.primary}30` }]} />
                  {/* Connector line below this thread item's avatar */}
                  <View style={[styles.itemConnectorLine, { left: TIMELINE_LINE_OFFSET, backgroundColor: `${theme.colors.primary}30` }]} />
                  <View style={styles.threadItemWithTimeline}>
                    <View style={[styles.headerRow, { paddingHorizontal: HPAD }]}>
                      <TouchableOpacity activeOpacity={0.7}>
                        <Avatar
                          source={user?.avatar}
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
                            onFocus={() => setFocusedItemId(item.id)}
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
                              onSourcesPress={() => {
                                const currentThreadId = item.id;
                                bottomSheet.setBottomSheetContent(
                                  <Suspense fallback={null}>
                                    <SourcesSheet
                                      sources={item.sources}
                                      onAdd={() => {
                                        const newSource = { id: generateSourceId(), title: '', url: '' };
                                        addThreadSource(currentThreadId, newSource);
                                      }}
                                      onUpdate={(id: string, field: 'url' | 'title', value: string) => {
                                        updateThreadSourceField(currentThreadId, id, field, value);
                                      }}
                                      onRemove={(id: string) => {
                                        removeThreadSource(currentThreadId, id);
                                      }}
                                      onClose={() => bottomSheet.openBottomSheet(false)}
                                      validateUrl={isValidSourceUrl}
                                    />
                                  </Suspense>
                                );
                                bottomSheet.openBottomSheet(true);
                              }}
                              onArticlePress={() => openThreadArticleEditor(item.id)}
                              onEventPress={() => openThreadEventEditor(item.id)}
                              onRoomPress={() => {
                                const currentThreadId = item.id;
                                bottomSheet.setBottomSheetContent(
                                  <Suspense fallback={null}>
                                    <CreateRoomSheet
                                      onClose={() => bottomSheet.openBottomSheet(false)}
                                      mode="embed"
                                      onRoomCreated={(createdRoom) => {
                                        setThreadRoom(currentThreadId, {
                                          roomId: createdRoom._id,
                                          title: createdRoom.title,
                                          status: createdRoom.status,
                                          topic: createdRoom.topic,
                                          host: createdRoom.host,
                                        });
                                      }}
                                    />
                                  </Suspense>
                                );
                                bottomSheet.openBottomSheet(true);
                              }}
                              hasLocation={!!item.location}
                              hasPoll={item.showPollCreator}
                              hasMedia={item.mediaIds.length > 0}
                              hasSources={item.sources.length > 0}
                              hasArticle={itemHasArticle}
                              hasEvent={itemHasEvent}
                              hasRoom={itemHasRoom}
                              disabled={isPosting}
                            />
                            {item.text.length > 0 && (
                              <Text className="text-muted-foreground" style={styles.characterCountText}>
                                {item.text.length}
                              </Text>
                            )}
                          </View>
                          <TouchableOpacity
                            style={styles.removeThreadBtn}
                            onPress={() => removeThread(item.id)}
                          >
                            <CloseIcon size={18} color="#5e5e5e" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>

                    {/* Thread item attachments row */}
                    {itemHasAttachments && (
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
                                className="border-border bg-secondary" style={styles.pollAttachmentCard}
                                activeOpacity={0.85}
                                onPress={() => {
                                  openThreadPollCreator(item.id);
                                  setTimeout(() => {
                                    threadPollTitleRefs.current[item.id]?.focus();
                                  }, 50);
                                }}
                              >
                                <View style={styles.pollAttachmentHeader}>
                                  <View className="bg-background" style={styles.pollAttachmentBadge}
                                  >
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
                                        key={`thread-${item.id}-poll-opt-${index}`}
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
                                onPress={() => removeThreadPoll(item.id)}
                                className="bg-background" style={styles.pollAttachmentRemoveButton}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                              >
                                <CloseIcon size={16} className="text-foreground" />
                              </TouchableOpacity>
                            </View>
                          ) : null}
                          {item.mediaIds.map((mediaItem, mediaIndex) => {
                            const mediaUrl = oxyServices.getFileDownloadUrl(mediaItem.id);
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
                                  className="bg-background" style={styles.mediaRemoveButton}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
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
                                onPress={() => openThreadArticleEditor(item.id)}
                              >
                                <PostArticlePreview
                                  title={item.article.title}
                                  body={item.article.body}
                                  onPress={() => openThreadArticleEditor(item.id)}
                                  style={styles.articleAttachmentPreview}
                                />
                              </TouchableOpacity>
                              <TouchableOpacity
                                onPress={() => removeThreadArticle(item.id)}
                                className="bg-background" style={styles.pollAttachmentRemoveButton}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
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
                                onPress={() => openThreadEventEditor(item.id)}
                              >
                                <PostAttachmentEvent
                                  name={item.event.name}
                                  date={item.event.date}
                                  location={item.event.location}
                                  onPress={() => openThreadEventEditor(item.id)}
                                  style={styles.articleAttachmentPreview}
                                />
                              </TouchableOpacity>
                              <TouchableOpacity
                                onPress={() => removeThreadEvent(item.id)}
                                className="bg-background" style={styles.pollAttachmentRemoveButton}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
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
                                onPress={() => removeThreadRoom(item.id)}
                                className="bg-background" style={styles.pollAttachmentRemoveButton}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
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

                    {/* Per-item interaction settings (beast mode only) */}
                    {postingMode === 'beast' && (
                      <View style={{ marginLeft: BOTTOM_LEFT_PAD, paddingHorizontal: HPAD }}>
                        <InteractionSettingsPills
                          replyPermission={item.replyPermission}
                          quotesDisabled={item.quotesDisabled}
                          isSensitive={item.isSensitive}
                          onReplySettingsPress={() => {
                            const currentThreadId = item.id;
                            bottomSheet.setBottomSheetContent(
                              <Suspense fallback={null}>
                                <ReplySettingsSheet
                                  onClose={() => bottomSheet.openBottomSheet(false)}
                                  replyPermission={item.replyPermission}
                                  onReplyPermissionChange={(permission) => setThreadReplyPermission(currentThreadId, permission)}
                                  quotesDisabled={item.quotesDisabled}
                                  onQuotesDisabledChange={(disabled) => setThreadQuotesDisabled(currentThreadId, disabled)}
                                />
                              </Suspense>
                            );
                            bottomSheet.openBottomSheet(true);
                          }}
                          onSensitiveToggle={() => setThreadSensitive(item.id, !item.isSensitive)}
                        />
                      </View>
                    )}
                  </View>
                </View>
                );
              })}

              {/* Add thread/post button */}
              <TouchableOpacity
                style={styles.postContainer}
                onPress={() => {
                  const newId = addThread(postingMode === 'beast' ? { replyPermission, reviewReplies, quotesDisabled, isSensitive } : undefined);
                  if (newId) {
                    setFocusedItemId(newId);
                    setTimeout(() => {
                      threadTextInputRefs.current[newId]?.focus();
                    }, 100);
                  }
                }}
              >
                {/* Connector line above add button's avatar */}
                <View style={[styles.itemConnectorLineAbove, { left: TIMELINE_LINE_OFFSET, backgroundColor: `${theme.colors.primary}30` }]} />
                <View style={[styles.headerRow, { paddingHorizontal: HPAD }]}>
                  <TouchableOpacity activeOpacity={0.7}>
                    <Avatar
                      source={user?.avatar}
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
            </ScrollView>

            <View style={[styles.bottomBar, bottomBarVisible && { paddingBottom: 80 }]}>
              {!(postingMode === 'beast' && threadItems.length > 0) && (
                <>
                  <TouchableOpacity
                    onPress={openReplySettings}
                    activeOpacity={0.7}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: theme.colors.backgroundSecondary,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 20,
                      gap: 5,
                    }}
                  >
                    <Ionicons
                      name={anyoneCanInteract ? 'earth-outline' : 'people-outline'}
                      size={16}
                      color={theme.colors.textSecondary}
                    />
                    <Text
                      numberOfLines={1}
                      style={{
                        fontSize: 13,
                        fontWeight: '500',
                        color: theme.colors.textSecondary,
                      }}
                    >
                      {interactionLabel}
                    </Text>
                    <Ionicons
                      name="chevron-down"
                      size={12}
                      color={theme.colors.textTertiary}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setIsSensitive(!isSensitive)}
                    activeOpacity={0.7}
                    style={styles.sensitiveToggle}
                  >
                    <Ionicons
                      name={isSensitive ? 'warning' : 'warning-outline'}
                      size={16}
                      color={isSensitive ? theme.colors.error : theme.colors.textSecondary}
                    />
                    <Text style={[
                      styles.bottomText,
                      isSensitive && { color: theme.colors.error },
                    ]}>
                      {isSensitive ? t('compose.sensitive.on', 'CW: On') : t('compose.sensitive.off', 'CW')}
                    </Text>
                  </TouchableOpacity>
                </>
              )}
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
            bottomBarVisible && { bottom: 96 },
            !isPostButtonEnabled && [styles.floatingPostButtonDisabled, { backgroundColor: theme.colors.border }]
          ]}
        >
          {isPosting ? (
            <Loading variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <Text style={[isPostButtonEnabled ? styles.floatingPostTextDark : styles.floatingPostText, { color: theme.colors.card }]}>{isEditMode ? t('Save') : t('Post')}</Text>
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
        <ArticleEditor
          visible={Boolean(editingThreadArticleId)}
          title={threadArticleDraftTitle}
          body={threadArticleDraftBody}
          onTitleChange={setThreadArticleDraftTitle}
          onBodyChange={setThreadArticleDraftBody}
          onClose={closeThreadArticleEditor}
          onSave={saveThreadArticle}
        />
        <EventEditor
          visible={Boolean(editingThreadEventId)}
          name={threadEventDraftName}
          date={threadEventDraftDate}
          location={threadEventDraftLocation}
          description={threadEventDraftDescription}
          onNameChange={setThreadEventDraftName}
          onDateChange={setThreadEventDraftDate}
          onLocationChange={setThreadEventDraftLocation}
          onDescriptionChange={setThreadEventDraftDescription}
          onClose={closeThreadEventEditor}
          onSave={saveThreadEvent}
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
    color: '#5e5e5e',
  },
  postButton: {
    backgroundColor: '#005c67',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 60,
    alignItems: 'center',
  },
  postButtonDisabled: {
    backgroundColor: '#949494',
  },
  postButtonText: {
    color: '#FDFDFD',
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
    color: '#5e5e5e',
    marginTop: 2,
  },
  textInput: {
    flex: 1,
    fontSize: 18,
    lineHeight: 24,
    color: '#111111',
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
    backgroundColor: '#FAFAFA',
    borderWidth: 1,
    borderColor: '#ededed',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mediaButtonText: {
    color: '#3c3c3c',
    fontWeight: '600',
  },
  mediaInfoText: {
    color: '#5e5e5e',
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
    backgroundColor: '#FF3B30',
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
    color: '#111111',
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
    color: '#5e5e5e',
    fontSize: 16,
    flex: 1,
  },
  sensitiveToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 8,
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
    backgroundColor: '#949494',
    opacity: 0.7,
  },
  floatingPostText: {
    color: '#111111',
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
    backgroundColor: '#ededed',
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
    color: '#5e5e5e',
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
    backgroundColor: '#ededed',
    marginTop: 0,
    borderRadius: 1,
    minHeight: 24,
  },
  mainTextInput: {
    fontSize: 16,
    color: '#111111',
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
    color: '#5e5e5e',
  },
  // Post component structure styles
  postContainer: {
    flexDirection: 'column',
    gap: 12,
    paddingVertical: 12,
  },
  unfocusedItem: {
    opacity: 0.4,
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
    backgroundColor: '#ededed',
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
    borderColor: '#ededed',
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
    color: '#111111',
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
  threadScrollView: {
    flex: 1,
  },
  threadScrollContent: {
    flexGrow: 1,
  },
  threadContainer: {
    position: 'relative',
  },
  itemConnectorLine: {
    position: 'absolute',
    top: 60, // below avatar: 12px pad + 40px avatar + 8px gap
    bottom: 0,
    width: 2,
    borderRadius: 9999,
    zIndex: -1,
  },
  itemConnectorLineAbove: {
    position: 'absolute',
    top: 0,
    height: 4, // from container top to 8px before avatar (12px pad - 8px gap)
    width: 2,
    borderRadius: 9999,
    zIndex: -1,
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
    color: '#5e5e5e',
    marginBottom: 2,
  },
  activeModeLabel: {
    color: '#005c67',
  },
  modeDescription: {
    fontSize: 12,
    color: '#949494',
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
