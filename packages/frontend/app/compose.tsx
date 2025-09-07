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
} from 'react-native';
import { useOxy } from '@oxyhq/services';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../styles/colors';
import Avatar from '@/components/Avatar';
import PostHeader from '@/components/Post/PostHeader';
import PostMiddle from '@/components/Post/PostMiddle';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePostsStore } from '../stores/postsStore';

const ComposeScreen = () => {
  const [postContent, setPostContent] = useState('');
  const [threadItems, setThreadItems] = useState<{ id: string; text: string }[]>([]);
  const [isPosting, setIsPosting] = useState(false);
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const { user, showBottomSheet, oxyServices } = useOxy();
  const { createPost } = usePostsStore();
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
    if (!(hasText || hasMedia)) {
      toast.error(t('Add text or an image'));
      return;
    }

    setIsPosting(true);
    try {
      console.log('Attempting to create post...');

      // Create the main post request for the API
      const postRequest = {
        content: {
          text: postContent.trim(),
          images: mediaIds,
          thread: threadItems.map(t => ({ text: t.text.trim() })).filter(t => t.text?.length > 0)
        },
        mentions: [],
        hashtags: []
      };

      // Send main post to backend
      await createPost(postRequest);

      // If user added thread posts, create them sequentially linking to the main post
      if (threadItems.length > 0) {
        try {
          // Get created post id (newest)
          const newest = usePostsStore.getState().feeds.posts.items[0] || usePostsStore.getState().feeds.mixed.items[0];
          const mainPostId = newest?.id;
          if (mainPostId) {
            for (const item of threadItems) {
              const text = item.text;
              if (!text || text.trim().length === 0) continue;
              const threadReq = {
                content: { text: text.trim() },
                parentPostId: mainPostId,
                threadId: mainPostId,
                mentions: [],
                hashtags: []
              };
              // createPost will add to store locally as well
              await createPost(threadReq as any);
            }
          }
        } catch (err) {
          console.error('Failed to create thread posts:', err);
        }
      }

      // If poll enabled, create poll linked to the new post
      if (false) {
        // Poll creation removed - using toolbar icons instead
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

  const canPostContent = postContent.trim().length > 0 || mediaIds.length > 0;
  const isPostButtonEnabled = canPostContent && !isPosting;

  const openMediaPicker = () => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: true,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: any) => {
          if (!file?.contentType?.startsWith?.('image/')) {
            toast.error(t('Please select an image file'));
            return;
          }
          try {
            setMediaIds(prev => prev.includes(file.id) ? prev : [...prev, file.id]);
            toast.success(t('Image attached'));
          } catch (e: any) {
            toast.error(e?.message || t('Failed to attach image'));
          }
        },
        onConfirmSelection: async (files: any[]) => {
          const onlyImages = (files || []).filter(f => f?.contentType?.startsWith?.('image/'));
          if (onlyImages.length !== (files || []).length) {
            toast.error(t('Please select only image files'));
          }
          const ids = onlyImages.map(f => f.id);
          setMediaIds(prev => Array.from(new Set([...(prev || []), ...ids])));
        }
      }
    });
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar style="light" />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.composeArea}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.COLOR_BLACK_LIGHT_1} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('New post')}</Text>
          <View style={styles.headerIcons}>
            <TouchableOpacity style={styles.iconBtn}>
              <Ionicons name="reader-outline" size={20} color={colors.COLOR_BLACK_LIGHT_1} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn}>
              <Ionicons name="ellipsis-horizontal" size={20} color={colors.COLOR_BLACK_LIGHT_1} />
            </TouchableOpacity>
          </View>
        </View>

        {/* User info with topic */}
        <View style={styles.userInfoRow}>
          <Avatar
            source={user?.avatar ? { uri: oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') } : undefined}
            size={40}
            verified={Boolean(user?.verified)}
          />
          <View style={styles.userDetails}>
            <View style={styles.userNameRow}>
              <Text style={styles.userName}>{user?.name?.full || user?.username}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.COLOR_BLACK_LIGHT_4} />
              <Text style={styles.topicText}>{t('Add a topic')}</Text>
            </View>
            <Text style={styles.userHandle}>{t("What's new?")}</Text>
          </View>
        </View>

        {/* Main composer and thread section */}
        <View style={styles.threadContainer}>
          {/* Continuous timeline line for all items - from What's new to Add to thread */}
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
                <TextInput
                  style={styles.mainTextInput}
                  placeholder={t("What's happening?")}
                  placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
                  value={postContent}
                  onChangeText={setPostContent}
                  multiline
                  autoFocus
                  textAlignVertical="top"
                />
                <View style={styles.toolbarRow}>
                  <TouchableOpacity onPress={openMediaPicker}>
                    <Ionicons name="image-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                  </TouchableOpacity>
                  <TouchableOpacity>
                    <Ionicons name="gift" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                  </TouchableOpacity>
                  <TouchableOpacity>
                    <Ionicons name="happy-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                  </TouchableOpacity>
                  <TouchableOpacity>
                    <Ionicons name="list-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                  </TouchableOpacity>
                  <TouchableOpacity>
                    <Ionicons name="document-text-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                  </TouchableOpacity>
                  <TouchableOpacity>
                    <Ionicons name="location-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                  </TouchableOpacity>
                </View>
              </PostHeader>

              <PostMiddle
                media={mediaIds.map(id => ({ id, url: oxyServices.getFileDownloadUrl(id, 'thumb') }))}
                leftOffset={BOTTOM_LEFT_PAD}
              />
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
                      <TextInput
                        style={styles.threadTextInput}
                        placeholder={t('Say more...')}
                        placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
                        value={item.text}
                        onChangeText={(v) => setThreadItems(prev => prev.map(p => p.id === item.id ? { ...p, text: v } : p))}
                        multiline
                      />
                      <View style={styles.toolbarRow}>
                        <TouchableOpacity>
                          <Ionicons name="image-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                        <TouchableOpacity>
                          <Ionicons name="gift" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                        <TouchableOpacity>
                          <Ionicons name="happy-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                        <TouchableOpacity>
                          <Ionicons name="list-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                        <TouchableOpacity>
                          <Ionicons name="document-text-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                        <TouchableOpacity>
                          <Ionicons name="location-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                      </View>
                      <TouchableOpacity
                        style={styles.removeThreadBtn}
                        onPress={() => setThreadItems(prev => prev.filter(p => p.id !== item.id))}
                      >
                        <Ionicons name="close" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          ))}

          {/* Add to thread button */}
          <TouchableOpacity
            style={styles.postContainer}
            onPress={() => {
              const id = Date.now().toString();
              setThreadItems(prev => [...prev, { id, text: '' }]);
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
                  <Text style={styles.addToThreadText}>{t('Add to thread')}</Text>
                </View>
              </View>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.bottomBar}>
          <Text style={styles.bottomText}>{t('Anyone can reply & quote')}</Text>
          <Text style={styles.characterCount}>{postContent.length}</Text>
        </View>
      </KeyboardAvoidingView>

      {/* Floating post button */}
      <TouchableOpacity
        onPress={handlePost}
        disabled={!isPostButtonEnabled}
        style={[
          styles.floatingPostButton,
          !isPostButtonEnabled && styles.floatingPostButtonDisabled
        ]}
      >
        {isPosting ? (
          <ActivityIndicator size="small" color="#000" />
        ) : (
          <Text style={isPostButtonEnabled ? styles.floatingPostTextDark : styles.floatingPostText}>{t('Post')}</Text>
        )}
      </TouchableOpacity>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_9,
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
  userDetails: {
    marginLeft: 12,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.COLOR_BLACK_LIGHT_1,
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
  userInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  userNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  topicText: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
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
  toolbarRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 8,
    paddingVertical: 4,
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
    borderBottomWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
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
    top: -32, // Start at center of "What's new?" avatar (center of 40px avatar)
    height: '100%', // Use full height of container, no extending beyond
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
});

export default ComposeScreen;
