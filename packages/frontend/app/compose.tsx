import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { useOxy } from '@oxyhq/services';
import { Ionicons } from '@expo/vector-icons';
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

const ComposeScreen = () => {
  const theme = useTheme();
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
  const { user, showBottomSheet, oxyServices } = useOxy();
  const { createPost, createThread } = usePostsStore();
  const { t } = useTranslation();

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
        hashtags: []
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
            hashtags: []
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
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: theme.colors.text }]}>{t('New post')}</Text>
            <View style={styles.headerIcons}>
              <TouchableOpacity style={styles.iconBtn}>
                <Ionicons name="reader-outline" size={20} color={theme.colors.text} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconBtn}>
                <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.text} />
              </TouchableOpacity>
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
              <Switch
                value={postingMode === 'beast'}
                onValueChange={(value) => setPostingMode(value ? 'beast' : 'thread')}
                trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                thumbColor={theme.colors.card}
                style={styles.modeSwitch}
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
                  <ComposeToolbar
                    onMediaPress={openMediaPicker}
                    onPollPress={openPollCreator}
                    onLocationPress={requestLocation}
                    hasLocation={!!location}
                    isGettingLocation={isGettingLocation}
                    hasPoll={showPollCreator}
                    hasMedia={mediaIds.length > 0}
                    disabled={isPosting}
                  />
                </PostHeader>

                <PostMiddle
                  media={mediaIds.map(m => ({ id: m.id, type: m.type }))}
                  leftOffset={BOTTOM_LEFT_PAD}
                />

                {/* Poll Creator */}
                {showPollCreator && (
                  <View style={[styles.pollCreator, { marginLeft: BOTTOM_LEFT_PAD }]}>
                    <View style={styles.pollHeader}>
                      <Text style={styles.pollTitle}>{t('Create a poll')}</Text>
                      <TouchableOpacity onPress={removePoll}>
                        <Ionicons name="close" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
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
                            <Ionicons name="close-circle" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                          </TouchableOpacity>
                        )}
                      </View>
                    ))}
                    {pollOptions.length < 4 && (
                      <TouchableOpacity style={styles.addPollOptionBtn} onPress={addPollOption}>
                        <Ionicons name="add" size={16} color={colors.primaryColor} />
                        <Text style={styles.addPollOptionText}>{t('Add option')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {/* Location Display */}
                {location && (
                  <View style={[styles.locationDisplay, { marginLeft: BOTTOM_LEFT_PAD }]}>
                    <View style={styles.locationHeader}>
                      <Ionicons name="location" size={16} color={colors.primaryColor} />
                      <Text style={styles.locationText}>{location.address}</Text>
                      <TouchableOpacity onPress={removeLocation}>
                        <Ionicons name="close" size={16} color={colors.COLOR_BLACK_LIGHT_4} />
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
                        <ComposeToolbar
                          onMediaPress={() => openThreadMediaPicker(item.id)}
                          onPollPress={() => openThreadPollCreator(item.id)}
                          onLocationPress={() => requestThreadLocation(item.id)}
                          hasLocation={!!item.location}
                          hasPoll={item.showPollCreator}
                          hasMedia={item.mediaIds.length > 0}
                          disabled={isPosting}
                        />
                        <TouchableOpacity
                          style={styles.removeThreadBtn}
                          onPress={() => setThreadItems(prev => prev.filter(p => p.id !== item.id))}
                        >
                          <Ionicons name="close" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>

                  {/* Thread item media */}
                  {item.mediaIds.length > 0 && (
                    <PostMiddle
                      media={item.mediaIds.map(m => ({ id: m.id, type: m.type }))}
                      leftOffset={BOTTOM_LEFT_PAD}
                    />
                  )}

                  {/* Thread item poll creator */}
                  {item.showPollCreator && (
                    <View style={[styles.pollCreator, { marginLeft: BOTTOM_LEFT_PAD }]}>
                      <View style={styles.pollHeader}>
                        <Text style={styles.pollTitle}>{t('Create a poll')}</Text>
                        <TouchableOpacity onPress={() => removeThreadPoll(item.id)}>
                          <Ionicons name="close" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
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
                              <Ionicons name="close-circle" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                            </TouchableOpacity>
                          )}
                        </View>
                      ))}
                      {item.pollOptions.length < 4 && (
                        <TouchableOpacity style={styles.addPollOptionBtn} onPress={() => addThreadPollOption(item.id)}>
                          <Ionicons name="add" size={16} color={colors.primaryColor} />
                          <Text style={styles.addPollOptionText}>{t('Add option')}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Thread item location display */}
                  {item.location && (
                    <View style={[styles.locationDisplay, { marginLeft: BOTTOM_LEFT_PAD }]}>
                      <View style={styles.locationHeader}>
                        <Ionicons name="location" size={16} color={colors.primaryColor} />
                        <Text style={styles.locationText}>{item.location.address}</Text>
                        <TouchableOpacity onPress={() => removeThreadLocation(item.id)}>
                          <Ionicons name="close" size={16} color={colors.COLOR_BLACK_LIGHT_4} />
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
            <Text style={styles.bottomText}>{t('Anyone can reply & quote')}</Text>
            <Text style={styles.characterCount}>{postContent.length}</Text>
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
  characterCount: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
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
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  iconBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginLeft: 8,
    borderRadius: 20,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtn: {
    padding: 10,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
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
  modeSwitch: {
    marginHorizontal: 20,
  },
});

export default ComposeScreen;
