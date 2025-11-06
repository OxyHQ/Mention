import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useOxy } from '@oxyhq/services';
import { StatusBar } from 'expo-status-bar';
import { ThemedView } from '@/components/ThemedView';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import { colors } from '../styles/colors';
import Avatar from '@/components/Avatar';
import PostHeader from '@/components/Post/PostHeader';
import PostMiddle from '@/components/Post/PostMiddle';
import ComposeToolbar from '@/components/ComposeToolbar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePostsStore } from '../stores/postsStore';
import { GeoJSONPoint } from '@mention/shared-types';
import { useTheme } from '@/hooks/useTheme';
import MentionTextInput, { MentionData } from '@/components/MentionTextInput';
import SEO from '@/components/SEO';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { DraftsIcon } from '@/assets/icons/drafts';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { CloseIcon } from '@/assets/icons/close-icon';
import { DotIcon } from '@/assets/icons/dot-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import DraftsSheet from '@/components/Compose/DraftsSheet';
import ReplySettingsSheet, { ReplyPermission } from '@/components/Compose/ReplySettingsSheet';
import { Toggle } from '@/components/Toggle';
import { useDrafts } from '@/hooks/useDrafts';
import { VideoView, useVideoPlayer } from 'expo-video';
import { ScrollView, Image, Dimensions } from 'react-native';

// Video preview component for compose screen
const VideoItemPreview: React.FC<{ src: string }> = ({ src }) => {
  const player = useVideoPlayer(src, (player) => {
    if (player) {
      player.loop = true;
      player.muted = true;
    }
  });

  React.useEffect(() => {
    if (player) {
      player.play();
    }
    return () => {
      if (player) {
        player.pause();
      }
    };
  }, [player]);

  return (
    <VideoView
      player={player}
      style={{ width: '100%', height: '100%' }}
      contentFit="cover"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
};

const ComposeScreen = () => {
  const theme = useTheme();
  const bottomSheet = React.useContext(BottomSheetContext);
  const { saveDraft, deleteDraft, loadDrafts } = useDrafts();
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [postContent, setPostContent] = useState('');
  const [mentions, setMentions] = useState<MentionData[]>([]);
  const [threadItems, setThreadItems] = useState<{
    id: string;
    text: string;
    mediaIds: Array<{ id: string; type: 'image' | 'video' }>;
    pollOptions: string[];
    showPollCreator: boolean;
    location: { latitude: number; longitude: number; address?: string } | null;
    mentions: MentionData[];
  }[]>([]);
  const [isPosting, setIsPosting] = useState(false);
  const [mediaIds, setMediaIds] = useState<Array<{ id: string; type: 'image' | 'video' }>>([]);
  const [pollOptions, setPollOptions] = useState<string[]>([]);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
    address?: string;
  } | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);
  const [postingMode, setPostingMode] = useState<'thread' | 'beast'>('thread');
  const [replyPermission, setReplyPermission] = useState<ReplyPermission>('anyone');
  const [reviewReplies, setReviewReplies] = useState(false);
  const { user, showBottomSheet, oxyServices } = useOxy();
  const { createPost, createThread } = usePostsStore();
  const { t } = useTranslation();

  // Use refs to always get latest values in timeout callback
  const postContentRef = useRef(postContent);
  const mediaIdsRef = useRef(mediaIds);
  const pollOptionsRef = useRef(pollOptions);
  const showPollCreatorRef = useRef(showPollCreator);
  const locationRef = useRef(location);
  const threadItemsRef = useRef(threadItems);
  const mentionsRef = useRef(mentions);
  const postingModeRef = useRef(postingMode);
  const currentDraftIdRef = useRef(currentDraftId);

  // Update refs when state changes
  useEffect(() => {
    postContentRef.current = postContent;
  }, [postContent]);
  useEffect(() => {
    mediaIdsRef.current = mediaIds;
  }, [mediaIds]);
  useEffect(() => {
    pollOptionsRef.current = pollOptions;
  }, [pollOptions]);
  useEffect(() => {
    showPollCreatorRef.current = showPollCreator;
  }, [showPollCreator]);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);
  useEffect(() => {
    threadItemsRef.current = threadItems;
  }, [threadItems]);
  useEffect(() => {
    mentionsRef.current = mentions;
  }, [mentions]);
  useEffect(() => {
    postingModeRef.current = postingMode;
  }, [postingMode]);
  useEffect(() => {
    currentDraftIdRef.current = currentDraftId;
  }, [currentDraftId]);

  // Keep this in sync with PostItem constants
  const HPAD = 16;
  const AVATAR_SIZE = 40;
  const AVATAR_GAP = 12;
  const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52
  const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET; // 68

  const handlePost = async () => {
    if (isPosting || !user) return;
    const hasText = postContent.trim().length > 0;
    const hasMedia = mediaIds.length > 0;
    const hasPoll = pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0);
    if (!(hasText || hasMedia || hasPoll)) {
      toast.error(t('Add text, an image, or a poll'));
      return;
    }

    setIsPosting(true);
    try {
      console.log('Attempting to create posts...');

      // Prepare all posts (main + thread items)
      const allPosts = [];

      // Main post
      allPosts.push({
        content: {
          text: postContent.trim(),
          media: mediaIds.map(m => ({ id: m.id, type: m.type })),
          // Include poll if user created one
          ...(hasPoll && {
            poll: {
              question: postContent.trim() || 'Poll',
              options: pollOptions.filter(opt => opt.trim().length > 0),
              endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              votes: {},
              userVotes: {}
            }
          }),
          // Include location if user shared their location
          ...(location && {
            location: {
              type: 'Point' as const,
              coordinates: [location.longitude, location.latitude],
              address: location.address
            } as GeoJSONPoint
          })
        },
        mentions: mentions.map(m => m.userId),
        hashtags: [],
        replyPermission: replyPermission,
        reviewReplies: reviewReplies
      });

      // Add thread items if any
      threadItems.forEach(item => {
        if (item.text.trim().length > 0 || item.mediaIds.length > 0 ||
          (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0))) {
          allPosts.push({
            content: {
              text: item.text.trim(),
              media: item.mediaIds.map(m => ({ id: m.id, type: m.type })),
              // Include poll if this thread item has poll options
              ...(item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0) && {
                poll: {
                  question: item.text.trim() || 'Poll',
                  options: item.pollOptions.filter(opt => opt.trim().length > 0),
                  endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                  votes: {},
                  userVotes: {}
                }
              }),
              // Include location if user shared location for this thread item
              ...(item.location && {
                location: {
                  type: 'Point' as const,
                  coordinates: [item.location.longitude, item.location.latitude],
                  address: item.location.address
                } as GeoJSONPoint
              })
            },
            mentions: item.mentions?.map(m => m.userId) || [],
            hashtags: [],
            replyPermission: replyPermission,
            reviewReplies: reviewReplies
          });
        }
      });

      console.log(`📝 Creating ${allPosts.length} posts in ${postingMode} mode`);

      // Send to backend based on whether we have multiple posts or just one
      if (allPosts.length === 1) {
        // Single post - use regular createPost
        await createPost(allPosts[0] as any);
      } else {
        // Multiple posts - use createThread
        await createThread({
          mode: postingMode,
          posts: allPosts
        });
      }

      // Clear current draft if it exists
      if (currentDraftId) {
        await deleteDraft(currentDraftId);
        setCurrentDraftId(null);
      }

      // Show success toast
      toast.success(t('Post published successfully'));

      // Navigate back after posting
      router.back();
    } catch (error: any) {
      console.error('Error creating post:', error);
      toast.error(t('Failed to publish post'));
    } finally {
      setIsPosting(false);
    }
  };

  // Auto-save draft function - uses refs to always get latest values
  const autoSaveDraft = useCallback(async () => {
    // Get latest values from refs
    const latestPostContent = postContentRef.current;
    const latestMediaIds = mediaIdsRef.current;
    const latestPollOptions = pollOptionsRef.current;
    const latestShowPollCreator = showPollCreatorRef.current;
    const latestLocation = locationRef.current;
    const latestThreadItems = threadItemsRef.current;
    const latestMentions = mentionsRef.current;
    const latestPostingMode = postingModeRef.current;
    const latestCurrentDraftId = currentDraftIdRef.current;

    // Only save if there's content
    const hasContent = latestPostContent.trim().length > 0 || 
      latestMediaIds.length > 0 || 
      (latestPollOptions.length > 0 && latestPollOptions.some(opt => opt.trim().length > 0)) ||
      latestLocation ||
      latestThreadItems.some(item => item.text.trim().length > 0 || item.mediaIds.length > 0 || 
        (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0)) || item.location);

    if (!hasContent) {
      // If no content and we have a draft, delete it
      if (latestCurrentDraftId) {
        await deleteDraft(latestCurrentDraftId);
        setCurrentDraftId(null);
      }
      return;
    }

    try {
      // Ensure showPollCreator is saved correctly - if pollOptions exist, showPollCreator should be true
      const shouldShowPollCreator = latestShowPollCreator || (latestPollOptions.length > 0 && latestPollOptions.some(opt => opt.trim().length > 0));
      
      const draftId = await saveDraft({
        id: latestCurrentDraftId || undefined,
        postContent: latestPostContent,
        mediaIds: latestMediaIds.map(m => ({ id: m.id, type: m.type })), // Ensure correct structure
        pollOptions: latestPollOptions || [],
        showPollCreator: shouldShowPollCreator,
        location: latestLocation ? {
          latitude: latestLocation.latitude,
          longitude: latestLocation.longitude,
          address: latestLocation.address || null,
        } : null,
        threadItems: latestThreadItems.map(item => ({
          id: item.id,
          text: item.text,
          mediaIds: item.mediaIds.map(m => ({ id: m.id, type: m.type })), // Ensure correct structure
          pollOptions: item.pollOptions || [],
          showPollCreator: item.showPollCreator || (item.pollOptions && item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0)),
          location: item.location ? {
            latitude: item.location.latitude,
            longitude: item.location.longitude,
            address: item.location.address || null,
          } : null,
          mentions: item.mentions.map(m => ({
            userId: m.userId,
            handle: m.handle,
            name: m.name,
          })),
        })),
        mentions: latestMentions.map(m => ({
          userId: m.userId,
          handle: m.handle,
          name: m.name,
        })),
        postingMode: latestPostingMode,
      });
      setCurrentDraftId(draftId);
    } catch (error) {
      console.error('Error auto-saving draft:', error);
    }
  }, [saveDraft, deleteDraft]);

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
      autoSaveDraft();
    }, 2000);

    // Cleanup on unmount
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [postContent, mediaIds, pollOptions, showPollCreator, location, threadItems, mentions, postingMode, autoSaveDraft]);

  // Load draft function
  const loadDraft = useCallback((draft: any) => {
    setPostContent(draft.postContent || '');
    
    // Handle mediaIds - ensure correct structure
    const mediaIdsData = (draft.mediaIds || []).map((m: any) => ({
      id: m.id || m,
      type: (m.type || 'image') as 'image' | 'video',
    })).filter((m: any) => m.id); // Filter out invalid entries
    setMediaIds(mediaIdsData);
    
    // Handle poll options - ensure showPollCreator is true if pollOptions exist
    const pollOpts = draft.pollOptions || [];
    setPollOptions(pollOpts);
    setShowPollCreator(draft.showPollCreator || pollOpts.length > 0);
    
    // Handle location - ensure it has the correct structure
    let locationData = null;
    if (draft.location) {
      locationData = {
        latitude: draft.location.latitude,
        longitude: draft.location.longitude,
        address: draft.location.address || null,
      };
    }
    setLocation(locationData);
    
    // Handle thread items - ensure they have all required fields
    const threadItemsData = (draft.threadItems || []).map((item: any) => ({
      id: item.id || `thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      text: item.text || '',
      mediaIds: (item.mediaIds || []).map((m: any) => ({
        id: m.id || m,
        type: (m.type || 'image') as 'image' | 'video',
      })).filter((m: any) => m.id),
      pollOptions: item.pollOptions || [],
      showPollCreator: item.showPollCreator || (item.pollOptions && item.pollOptions.length > 0),
      location: item.location ? {
        latitude: item.location.latitude,
        longitude: item.location.longitude,
        address: item.location.address || null,
      } : null,
      mentions: item.mentions || [],
    }));
    setThreadItems(threadItemsData);
    
    // Handle mentions - ensure correct structure
    const mentionsData = (draft.mentions || []).map((m: any) => ({
      userId: m.userId || m.id || m,
      handle: m.handle || m.username || '',
      name: m.name || '',
    })).filter((m: any) => m.userId);
    setMentions(mentionsData);
    
    setPostingMode(draft.postingMode || 'thread');
    setCurrentDraftId(draft.id);
    
    // Close bottom sheet
    bottomSheet.openBottomSheet(false);
    
    toast.success(t('compose.draftLoaded'));
  }, [bottomSheet, t]);

  // back navigation

  const canPostContent = postContent.trim().length > 0 || mediaIds.length > 0 || (pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0)) || location ||
    threadItems.some(item => item.text.trim().length > 0 || item.mediaIds.length > 0 || (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0)) || item.location);
  const isPostButtonEnabled = canPostContent && !isPosting;

  const openMediaPicker = () => {
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
            const mediaType = isImage ? 'image' : 'video';
            const mediaItem = { id: file.id, type: mediaType as 'image' | 'video' };
            setMediaIds(prev => prev.some(m => m.id === file.id) ? prev : [...prev, mediaItem]);
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
            type: (f.contentType?.startsWith('image/') ? 'image' : 'video') as 'image' | 'video'
          }));
          setMediaIds(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const newItems = mediaItems.filter(m => !existingIds.has(m.id));
            return [...prev, ...newItems];
          });
        }
      }
    });
  };

  const removeMedia = (mediaId: string) => {
    setMediaIds(prev => prev.filter(m => m.id !== mediaId));
    toast.success(t('Media removed'));
  };

  const removeThreadMedia = (threadId: string, mediaId: string) => {
    setThreadItems(prev => prev.map(item =>
      item.id === threadId
        ? { ...item, mediaIds: item.mediaIds.filter(m => m.id !== mediaId) }
        : item
    ));
    toast.success(t('Media removed'));
  };

  const openPollCreator = () => {
    setShowPollCreator(true);
    // Initialize with 2 empty options
    setPollOptions(['', '']);
  };

  const addPollOption = () => {
    setPollOptions(prev => [...prev, '']);
  };

  const updatePollOption = (index: number, value: string) => {
    setPollOptions(prev => prev.map((option, i) => i === index ? value : option));
  };

  const removePollOption = (index: number) => {
    if (pollOptions.length > 2) {
      setPollOptions(prev => prev.filter((_, i) => i !== index));
    }
  };

  const removePoll = () => {
    setShowPollCreator(false);
    setPollOptions([]);
  };

  // Location functions
  const requestLocation = async () => {
    setIsGettingLocation(true);
    try {
      // Request permissions
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        toast.error(t('Location permission denied'));
        return;
      }

      // Get current position
      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      // Reverse geocode to get address
      const reverseGeocode = await Location.reverseGeocodeAsync({
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

      setLocation(locationData);
      toast.success(t('Location added'));
    } catch (error) {
      console.error('Error getting location:', error);
      toast.error(t('Failed to get location'));
    } finally {
      setIsGettingLocation(false);
    }
  };

  const removeLocation = () => {
    setLocation(null);
    toast.success(t('Location removed'));
  };

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
            const mediaType = isImage ? 'image' : 'video';
            const mediaItem = { id: file.id, type: mediaType as 'image' | 'video' };
            setThreadItems(prev => prev.map(item =>
              item.id === threadId
                ? { ...item, mediaIds: item.mediaIds.some(m => m.id === file.id) ? item.mediaIds : [...item.mediaIds, mediaItem] }
                : item
            ));
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
            type: (f.contentType?.startsWith('image/') ? 'image' : 'video') as 'image' | 'video'
          }));
          setThreadItems(prev => prev.map(item =>
            item.id === threadId
              ? {
                ...item,
                mediaIds: (() => {
                  const existingIds = new Set(item.mediaIds.map(m => m.id));
                  const newItems = mediaItems.filter(m => !existingIds.has(m.id));
                  return [...item.mediaIds, ...newItems];
                })()
              }
              : item
          ));
        }
      }
    });
  };

  const openThreadPollCreator = (threadId: string) => {
    setThreadItems(prev => prev.map(item =>
      item.id === threadId
        ? { ...item, showPollCreator: true, pollOptions: item.pollOptions.length === 0 ? ['', ''] : item.pollOptions }
        : item
    ));
  };

  const addThreadPollOption = (threadId: string) => {
    setThreadItems(prev => prev.map(item =>
      item.id === threadId
        ? { ...item, pollOptions: [...item.pollOptions, ''] }
        : item
    ));
  };

  const updateThreadPollOption = (threadId: string, index: number, value: string) => {
    setThreadItems(prev => prev.map(item =>
      item.id === threadId
        ? { ...item, pollOptions: item.pollOptions.map((option, i) => i === index ? value : option) }
        : item
    ));
  };

  const removeThreadPollOption = (threadId: string, index: number) => {
    setThreadItems(prev => prev.map(item =>
      item.id === threadId && item.pollOptions.length > 2
        ? { ...item, pollOptions: item.pollOptions.filter((_, i) => i !== index) }
        : item
    ));
  };

  const removeThreadPoll = (threadId: string) => {
    setThreadItems(prev => prev.map(item =>
      item.id === threadId
        ? { ...item, showPollCreator: false, pollOptions: [] }
        : item
    ));
  };

  // Thread location functions
  const requestThreadLocation = async (threadId: string) => {
    try {
      // Request permissions
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        toast.error(t('Location permission denied'));
        return;
      }

      // Get current position
      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      // Reverse geocode to get address
      const reverseGeocode = await Location.reverseGeocodeAsync({
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

      setThreadItems(prev => prev.map(item =>
        item.id === threadId
          ? { ...item, location: locationData }
          : item
      ));
      toast.success(t('Location added'));
    } catch (error) {
      console.error('Error getting location:', error);
      toast.error(t('Failed to get location'));
    }
  };

  const removeThreadLocation = (threadId: string) => {
    setThreadItems(prev => prev.map(item =>
      item.id === threadId
        ? { ...item, location: null }
        : item
    ));
    toast.success(t('Location removed'));
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

  // Update bottom sheet content when replyPermission or reviewReplies changes
  useEffect(() => {
    if (isReplySettingsOpen) {
      bottomSheet.setBottomSheetContent(
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
      );
    }
  }, [replyPermission, reviewReplies, isReplySettingsOpen]);

  const openReplySettings = () => {
    setIsReplySettingsOpen(true);
    bottomSheet.setBottomSheetContent(
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
    );
    bottomSheet.openBottomSheet(true);
  };
  
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
            <HeaderIconButton 
              onPress={() => {
                router.back();
              }} 
              style={styles.backBtn}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>
            <Text style={[styles.headerTitle, { color: theme.colors.text }]} pointerEvents="none">{t('New post')}</Text>
            <View style={styles.headerIcons}>
              <HeaderIconButton 
                style={styles.iconBtn}
                onPress={() => {
                  bottomSheet.setBottomSheetContent(
                    <DraftsSheet
                      onClose={() => bottomSheet.openBottomSheet(false)}
                      onLoadDraft={loadDraft}
                      currentDraftId={currentDraftId}
                    />
                  );
                  bottomSheet.openBottomSheet(true);
                }}
              >
                <DraftsIcon size={20} color={theme.colors.text} />
              </HeaderIconButton>
              <HeaderIconButton 
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
                          setShowPollCreator(false);
                          setLocation(null);
                          setThreadItems([]);
                          setMentions([]);
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
              </HeaderIconButton>
            </View>
          </View>

          {/* Mode Toggle Section */}
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

          {/* Main composer and thread section */}
          <View style={styles.threadContainer}>
            {/* Continuous timeline line for all items - from composer to add button */}
            <View style={styles.continuousTimelineLine} />

            {/* Main composer */}
            <View style={styles.postContainer}>
              <View style={styles.composerWithTimeline}>
                <PostHeader
                  user={{
                    name: user?.name?.full || user?.username || '',
                    handle: user?.username || '',
                    verified: Boolean(user?.verified)
                  }}
                  avatarUri={user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined}
                  onPressUser={() => { }}
                  onPressAvatar={() => { }}
                >
                  <MentionTextInput
                    style={[styles.mainTextInput, { color: theme.colors.text }]}
                    placeholder={t("What's new?")}
                    value={postContent}
                    onChangeText={setPostContent}
                    onMentionsChange={setMentions}
                    multiline
                    autoFocus
                  />
                  <View style={styles.toolbarWrapper}>
                    <ComposeToolbar
                      onMediaPress={openMediaPicker}
                      onPollPress={openPollCreator}
                      onLocationPress={requestLocation}
                      onGifPress={() => {
                        // TODO: Implement GIF picker
                        toast.info(t('GIF picker coming soon'));
                      }}
                      onEmojiPress={() => {
                        // TODO: Implement emoji picker
                        toast.info(t('Emoji picker coming soon'));
                      }}
                      hasLocation={!!location}
                      isGettingLocation={isGettingLocation}
                      hasPoll={showPollCreator}
                      hasMedia={mediaIds.length > 0}
                      disabled={isPosting}
                    />
                    {postContent.length > 0 && (
                      <Text style={[styles.characterCountText, { color: theme.colors.textSecondary }]}>
                        {postContent.length}
                      </Text>
                    )}
                  </View>
                </PostHeader>

                {/* Custom Media Display with Delete Buttons */}
                {mediaIds.length > 0 && (
                  <View style={{ marginLeft: BOTTOM_LEFT_PAD, marginTop: 12, zIndex: 1, backgroundColor: theme.colors.background }}>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ gap: 12, paddingRight: 12 }}
                      style={{ zIndex: 1 }}
                    >
                      {mediaIds.map((mediaItem) => {
                        const mediaUrl = oxyServices.getFileDownloadUrl(mediaItem.id);
                        const CARD_WIDTH = 280;
                        const CARD_HEIGHT = 180;
                        
                        return (
                          <View
                            key={mediaItem.id}
                            style={[
                              {
                                width: CARD_WIDTH,
                                height: CARD_HEIGHT,
                                borderRadius: 15,
                                borderWidth: 1,
                                borderColor: theme.colors.border,
                                backgroundColor: theme.colors.backgroundSecondary,
                                overflow: 'hidden',
                                position: 'relative',
                              },
                            ]}
                          >
                            {mediaItem.type === 'video' ? (
                              <VideoItemPreview src={mediaUrl} />
                            ) : (
                              <Image
                                source={{ uri: mediaUrl }}
                                style={{ width: '100%', height: '100%' }}
                                resizeMode="cover"
                              />
                            )}
                            <View
                              style={{
                                position: 'absolute',
                                top: 8,
                                right: 8,
                              }}
                            >
                              <HeaderIconButton
                                onPress={() => removeMedia(mediaItem.id)}
                                style={{ padding: 6 }}
                              >
                                <CloseIcon size={16} color={theme.colors.text} />
                              </HeaderIconButton>
                            </View>
                          </View>
                        );
                      })}
                    </ScrollView>
                  </View>
                )}

                {/* Poll Creator */}
                {showPollCreator && (
                  <View style={[styles.pollCreator, { marginLeft: BOTTOM_LEFT_PAD }]}>
                    <View style={styles.pollHeader}>
                      <Text style={styles.pollTitle}>{t('Create a poll')}</Text>
                      <TouchableOpacity onPress={removePoll}>
                        <CloseIcon size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                      </TouchableOpacity>
                    </View>
                    {pollOptions.map((option, index) => (
                      <View key={index} style={styles.pollOptionRow}>
                        <TextInput
                          style={styles.pollOptionInput}
                          placeholder={t(`Option ${index + 1}`)}
                          placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
                          value={option}
                          onChangeText={(value) => updatePollOption(index, value)}
                          maxLength={50}
                        />
                        {pollOptions.length > 2 && (
                          <TouchableOpacity onPress={() => removePollOption(index)}>
                            <CloseIcon size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                          </TouchableOpacity>
                        )}
                      </View>
                    ))}
                    {pollOptions.length < 4 && (
                      <TouchableOpacity style={styles.addPollOptionBtn} onPress={addPollOption}>
                        <Plus size={16} color={colors.primaryColor} />
                        <Text style={styles.addPollOptionText}>{t('Add option')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {/* Location Display */}
                {location && (
                  <View style={[styles.locationDisplay, { marginLeft: BOTTOM_LEFT_PAD }]}>
                    <View style={styles.locationHeader}>
                      <LocationIcon size={16} color={colors.primaryColor} />
                      <Text style={styles.locationText}>{location.address}</Text>
                      <TouchableOpacity onPress={removeLocation}>
                        <CloseIcon size={16} color={colors.COLOR_BLACK_LIGHT_4} />
                      </TouchableOpacity>
                    </View>
                  </View>
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
                          style={styles.threadTextInput}
                          placeholder={t('Say more...')}
                          value={item.text}
                          onChangeText={(v) => setThreadItems(prev => prev.map(p => p.id === item.id ? { ...p, text: v } : p))}
                          onMentionsChange={(m) => setThreadItems(prev => prev.map(p => p.id === item.id ? { ...p, mentions: m } : p))}
                          multiline
                        />
                        <View style={styles.toolbarWrapper}>
                          <ComposeToolbar
                            onMediaPress={() => openThreadMediaPicker(item.id)}
                            onPollPress={() => openThreadPollCreator(item.id)}
                            onLocationPress={() => requestThreadLocation(item.id)}
                            onGifPress={() => {
                              // TODO: Implement GIF picker for thread items
                              toast.info(t('GIF picker coming soon'));
                            }}
                            onEmojiPress={() => {
                              // TODO: Implement emoji picker for thread items
                              toast.info(t('Emoji picker coming soon'));
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
                          onPress={() => setThreadItems(prev => prev.filter(p => p.id !== item.id))}
                        >
                          <CloseIcon size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>

                  {/* Thread item media with Delete Buttons */}
                  {item.mediaIds.length > 0 && (
                    <View style={{ marginLeft: BOTTOM_LEFT_PAD, marginTop: 12 }}>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: 12, paddingRight: 12 }}
                      >
                        {item.mediaIds.map((mediaItem) => {
                          const mediaUrl = oxyServices.getFileDownloadUrl(mediaItem.id);
                          const CARD_WIDTH = 280;
                          const CARD_HEIGHT = 180;
                          
                          return (
                            <View
                              key={mediaItem.id}
                              style={[
                                {
                                  width: CARD_WIDTH,
                                  height: CARD_HEIGHT,
                                  borderRadius: 15,
                                  borderWidth: 1,
                                  borderColor: theme.colors.border,
                                  backgroundColor: theme.colors.backgroundSecondary,
                                  overflow: 'hidden',
                                  position: 'relative',
                                },
                              ]}
                            >
                              {mediaItem.type === 'video' ? (
                                <VideoItemPreview src={mediaUrl} />
                              ) : (
                                <Image
                                  source={{ uri: mediaUrl }}
                                  style={{ width: '100%', height: '100%' }}
                                  resizeMode="cover"
                                />
                              )}
                              <View
                                style={{
                                  position: 'absolute',
                                  top: 8,
                                  right: 8,
                                }}
                              >
                                <HeaderIconButton
                                  onPress={() => removeThreadMedia(item.id, mediaItem.id)}
                                  style={{ padding: 6 }}
                                >
                                  <CloseIcon size={16} color={theme.colors.text} />
                                </HeaderIconButton>
                              </View>
                            </View>
                          );
                        })}
                      </ScrollView>
                    </View>
                  )}

                  {/* Thread item poll creator */}
                  {item.showPollCreator && (
                    <View style={[styles.pollCreator, { marginLeft: BOTTOM_LEFT_PAD }]}>
                      <View style={styles.pollHeader}>
                        <Text style={styles.pollTitle}>{t('Create a poll')}</Text>
                        <TouchableOpacity onPress={() => removeThreadPoll(item.id)}>
                          <CloseIcon size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                      </View>
                      {item.pollOptions.map((option, index) => (
                        <View key={index} style={styles.pollOptionRow}>
                          <TextInput
                            style={styles.pollOptionInput}
                            placeholder={t(`Option ${index + 1}`)}
                            placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
                            value={option}
                            onChangeText={(value) => updateThreadPollOption(item.id, index, value)}
                            maxLength={50}
                          />
                          {item.pollOptions.length > 2 && (
                            <TouchableOpacity onPress={() => removeThreadPollOption(item.id, index)}>
                              <CloseIcon size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                            </TouchableOpacity>
                          )}
                        </View>
                      ))}
                      {item.pollOptions.length < 4 && (
                        <TouchableOpacity style={styles.addPollOptionBtn} onPress={() => addThreadPollOption(item.id)}>
                          <Plus size={16} color={colors.primaryColor} />
                          <Text style={styles.addPollOptionText}>{t('Add option')}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Thread item location display */}
                  {item.location && (
                    <View style={[styles.locationDisplay, { marginLeft: BOTTOM_LEFT_PAD }]}>
                      <View style={styles.locationHeader}>
                        <LocationIcon size={16} color={colors.primaryColor} />
                        <Text style={styles.locationText}>{item.location.address}</Text>
                        <TouchableOpacity onPress={() => removeThreadLocation(item.id)}>
                          <CloseIcon size={16} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </View>
              </View>
            ))}

            {/* Add thread/post button */}
            <TouchableOpacity
              style={styles.postContainer}
              onPress={() => {
                const id = Date.now().toString();
                setThreadItems(prev => [...prev, {
                  id,
                  text: '',
                  mediaIds: [] as Array<{ id: string; type: 'image' | 'video' }>,
                  pollOptions: [],
                  showPollCreator: false,
                  location: null,
                  mentions: []
                }]);
              }}
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
          <ActivityIndicator size="small" color={theme.colors.card} />
        ) : (
          <Text style={[isPostButtonEnabled ? styles.floatingPostTextDark : styles.floatingPostText, { color: theme.colors.card }]}>{t('Post')}</Text>
        )}
      </TouchableOpacity>
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
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 26,
    flexDirection: 'row',
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
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
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
    left: 35, // Center on avatar (16px padding + 20px avatar center - 1px)
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
  // Poll creator styles
  pollCreator: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
  },
  pollHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  pollTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  pollOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  pollOptionInput: {
    flex: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  addPollOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  addPollOptionText: {
    fontSize: 14,
    color: colors.primaryColor,
    fontWeight: '500',
  },
  // Location styles
  locationDisplay: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
  },
  locationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  locationText: {
    flex: 1,
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_2,
    fontWeight: '500',
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
});

export default ComposeScreen;
