import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    KeyboardAvoidingView,
    Platform,
    TextInput,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Avatar } from '@oxyhq/bloom/avatar';
import PostItem from '@/components/Feed/PostItem';
import PostDetailView from '@/components/Post/PostDetailView';
import Feed from '@/components/Feed/Feed';
import PostAttachmentsRow from '@/components/Post/PostAttachmentsRow';
import { useThreadPreferences, SORT_TO_API } from '@/hooks/useThreadPreferences';
import { usePostsStore } from '@/stores/postsStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ReplyPreferencesSheet from '@/components/ReplyPreferencesSheet';
import { FeedType } from '@mention/shared-types';
import { HydratedPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import { useAuth } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import ComposeToolbar from '@/components/ComposeToolbar';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import MentionTextInput, { MentionData } from '@/components/MentionTextInput';
import { statisticsService } from '@/services/statisticsService';
import SEO from '@/components/SEO';

const MAX_CHARACTERS = 280;

const PostDetailScreen: React.FC = () => {
    const { id } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const safeBack = useSafeBack();
    const { getPostById, createReply } = usePostsStore();
    const { user, showBottomSheet, oxyServices } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const { treeView, sortOrder } = useThreadPreferences();
    const { openBottomSheet, setBottomSheetContent } = React.useContext(BottomSheetContext);

    const [post, setPost] = useState<HydratedPost | Reply | Repost | null>(null);
    const [parentPost, setParentPost] = useState<HydratedPost | Reply | Repost | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [mentions, setMentions] = useState<MentionData[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [mediaIds, setMediaIds] = useState<Array<{ id: string; type: 'image' | 'video' }>>([]);
    const [pollOptions, setPollOptions] = useState<string[]>([]);
    const [showPollCreator, setShowPollCreator] = useState(false);
    const [location, setLocation] = useState<{
        latitude: number;
        longitude: number;
        address?: string;
    } | null>(null);
    const [isGettingLocation, setIsGettingLocation] = useState(false);
    const textInputRef = useRef<TextInput>(null);
    const [repliesReloadKey, setRepliesReloadKey] = useState(0);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const hasContent = content.trim().length > 0 || mediaIds.length > 0 || (pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0));
    const canReply = hasContent && !isOverLimit && !isSubmitting;

    // Memoize filters for replies feed
    const feedFilters = useMemo(() => ({
        postId: String(id),
        parentPostId: String(id),
        sort: SORT_TO_API[sortOrder],
    }), [id, sortOrder]);

    const openReplyPreferences = useCallback(() => {
        setBottomSheetContent(<ReplyPreferencesSheet />);
        openBottomSheet(true);
    }, [setBottomSheetContent, openBottomSheet]);

    // Memoize callbacks to prevent child re-renders
    const handleFocusInput = useCallback(() => {
        try {
            textInputRef.current?.focus();
        } catch {
            /* ignore focus errors */
        }
    }, []);

    // Media picker handler
    const openMediaPicker = useCallback(() => {
        if (showPollCreator) {
            toast.error(t('Cannot add media to a poll'));
            return;
        }
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
    }, [showBottomSheet, showPollCreator, t]);

    // Poll creator handler
    const openPollCreator = useCallback(() => {
        if (mediaIds.length > 0) {
            toast.error(t('Cannot add poll with media'));
            return;
        }
        setShowPollCreator(true);
        setPollOptions(['', '']);
    }, [mediaIds.length, t]);

    const addPollOption = useCallback(() => {
        setPollOptions(prev => [...prev, '']);
    }, []);

    const updatePollOption = useCallback((index: number, value: string) => {
        setPollOptions(prev => prev.map((option, i) => i === index ? value : option));
    }, []);

    const removePollOption = useCallback((index: number) => {
        if (pollOptions.length > 2) {
            setPollOptions(prev => prev.filter((_, i) => i !== index));
        }
    }, [pollOptions.length]);

    const removePoll = useCallback(() => {
        setShowPollCreator(false);
        setPollOptions([]);
    }, []);

    // Location handler
    const requestLocation = useCallback(async () => {
        setIsGettingLocation(true);
        try {
            const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
            if (status !== 'granted') {
                toast.error(t('Location permission denied'));
                return;
            }

            const currentLocation = await ExpoLocation.getCurrentPositionAsync({
                accuracy: ExpoLocation.Accuracy.Balanced,
            });

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

            setLocation(locationData);
            toast.success(t('Location added'));
        } catch (error) {
            toast.error(t('Failed to get location'));
        } finally {
            setIsGettingLocation(false);
        }
    }, [t]);

    const removeLocation = useCallback(() => {
        setLocation(null);
        toast.success(t('Location removed'));
    }, [t]);

    // Load post instantly from cache, fetch from API only if not cached
    useEffect(() => {
        const loadPost = async () => {
            if (!id) {
                setError('Post ID is required');
                setLoading(false);
                return;
            }

            try {
                setError(null);

                // Check cache first for instant loading (offline support)
                const { postsById } = usePostsStore.getState();
                const cachedPost = postsById[id];

                if (cachedPost) {
                    // Post is cached - load instantly
                    setPost(cachedPost as any);
                    setLoading(false);

                    // Fetch parent post if this is a reply
                    if ((cachedPost as any).parentPostId) {
                        const cachedParent = postsById[(cachedPost as any).parentPostId];
                        if (cachedParent) {
                            setParentPost(cachedParent as any);
                        } else {
                            try {
                                const parentResponse = await getPostById((cachedPost as any).parentPostId);
                                setParentPost(parentResponse);
                            } catch (parentErr) {
                                // Silently ignore parent fetch errors
                            }
                        }
                    }

                    // Track view in background (non-blocking)
                    if (user) {
                        statisticsService.trackPostView(String(id)).catch(() => {});
                    }
                } else {
                    // Post not in cache - fetch from API
                    setLoading(true);
                    const response = await getPostById(id);
                    setPost(response);

                    // Fetch parent post if this is a reply
                    if (response && (response as any).parentPostId) {
                        try {
                            const parentResponse = await getPostById((response as any).parentPostId);
                            setParentPost(parentResponse);
                        } catch (parentErr) {
                            // Silently ignore parent fetch errors
                        }
                    }

                    // Track post view
                    if (user) {
                        statisticsService.trackPostView(String(id)).catch(() => {});
                    }
                }
            } catch (err) {
                setError('Failed to load post');
            } finally {
                setLoading(false);
            }
        };

        loadPost();
    }, [id, getPostById, user]);

    const handleBack = () => {
        safeBack();
    };

    // Generate SEO data for the post (must be before any early returns)
    const getPostImage = useCallback(() => {
        if (!post) return undefined;
        const media = (post as any)?.content?.media || [];
        const firstImage = media.find((m: any) => m?.type === 'image');
        if (firstImage?.id && oxyServices?.getFileDownloadUrl) {
            return oxyServices.getFileDownloadUrl(firstImage.id);
        }
        return undefined;
    }, [post, oxyServices]);

    const postText = post?.content?.text || '';
    const postDescription = postText.length > 200
        ? `${postText.substring(0, 197)}...`
        : postText || t('seo.post.description', { defaultValue: 'View this post on Mention' });
    const postAuthor = post?.user?.displayName || post?.user?.handle || t('common.someone');
    const postTitle = t('seo.post.title', { author: postAuthor, defaultValue: `${postAuthor} on Mention` });
    const postImage = getPostImage();

    const handleReply = async () => {
        if (!canReply || !id) return;
        try {
            setIsSubmitting(true);

            const hasPoll = pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0);

            await createReply({
                postId: String(id),
                content: {
                    text: content.trim(),
                    media: mediaIds.map(m => ({ id: m.id, type: m.type })),
                    ...(hasPoll && {
                        poll: {
                            question: content.trim() || 'Poll',
                            options: pollOptions.filter(opt => opt.trim().length > 0),
                            endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                            votes: {},
                            userVotes: {}
                        }
                    }),
                    ...(location && {
                        location: {
                            type: 'Point' as const,
                            coordinates: [location.longitude, location.latitude],
                            address: location.address
                        }
                    })
                },
                mentions: mentions.map(m => m.userId),
                hashtags: [],
            });

            // Reset all form state
            setContent('');
            setMentions([]);
            setMediaIds([]);
            setPollOptions([]);
            setShowPollCreator(false);
            setLocation(null);

            toast.success(t('Reply posted!'));

            // Trigger filtered replies list reload
            setRepliesReloadKey(k => k + 1);
        } catch (error) {
            toast.error(t('Failed to post reply. Please try again.'));
        } finally {
            setIsSubmitting(false);
        }
    };

    // List header for Feed: parent post + main post + sort toggle
    const listHeader = useMemo(() => {
        if (!post) {
            return (
                <View className="items-center justify-center py-12">
                    <Loading size="large" />
                </View>
            );
        }
        return (
            <View>
                {parentPost && post?.parentPostId && (
                    <View className="border-b pb-3 mb-2 border-border">
                        <Text className="text-sm px-4 py-2 font-medium text-muted-foreground">Replying to</Text>
                        <PostItem
                            post={parentPost}
                            onReply={handleFocusInput}
                        />
                        <View className="w-0.5 h-3 ml-8 mt-1 bg-border" />
                    </View>
                )}

                <PostDetailView
                    post={post}
                    onFocusReply={handleFocusInput}
                />

                <View className="px-4 pt-4 pb-2">
                    <Text className="text-lg font-semibold text-foreground">Replies</Text>
                </View>
            </View>
        );
    }, [post, parentPost, handleFocusInput]);

    if (!loading && (error || !post)) {
        return (
            <>
                <SEO
                    title={t('seo.post.notFound')}
                    description={t('seo.post.notFoundDescription')}
                />
                <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
                    <Header
                        options={{
                            title: t('screens.post.title'),
                            leftComponents: [
                                <IconButton variant="icon"
                                    key="back"
                                    onPress={handleBack}
                                >
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                    <View className="flex-1 items-center justify-center px-8">
                        <Ionicons name="alert-circle-outline" size={48} color={theme.colors.error} />
                        <Text className="text-xl font-semibold mt-4 mb-2 text-foreground">Post Not Found</Text>
                        <Text className="text-base text-center leading-[22px] mb-6 text-muted-foreground">
                            {error || 'The post you\'re looking for doesn\'t exist or has been deleted.'}
                        </Text>
                        <TouchableOpacity className="px-6 py-3 rounded-lg bg-primary" onPress={() => safeBack()}>
                            <Text className="text-base font-semibold" style={{ color: theme.colors.card }}>Go Back</Text>
                        </TouchableOpacity>
                    </View>
                </ThemedView>
            </>
        );
    }

    return (
        <>
            <SEO
                title={postTitle}
                description={postDescription}
                image={postImage}
                type="article"
                author={postAuthor}
                publishedTime={post?.metadata?.createdAt}
                modifiedTime={post?.metadata?.updatedAt}
            />
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 56 : 0}
                className="flex-1"
                style={{ paddingTop: insets.top }}
            >
                <Header
                    options={{
                        title: post?.isThread ? 'Thread' : 'Post',
                        leftComponents: [
                            <IconButton variant="icon"
                                key="back"
                                onPress={handleBack}
                            >
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                        rightComponents: [
                            <IconButton variant="icon" key="reply-prefs" onPress={openReplyPreferences}>
                                <Ionicons name="options-outline" size={22} color={theme.colors.text} />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />

                <Feed
                    type={'replies' as FeedType}
                    filters={feedFilters}
                    reloadKey={repliesReloadKey}
                    listHeaderComponent={listHeader}
                    hideHeader={true}
                    threaded={treeView}
                    threadPostId={String(id)}
                    contentContainerStyle={styles.feedContent}
                />

                {/* Inline Reply Composer */}
                <ThemedView style={[styles.composerContainer, { borderTopColor: theme.colors.border, paddingBottom: Math.max(insets.bottom, 8) }]}
                >
                    <View>
                        <View className="flex-row items-start gap-2">
                            <View className="pt-2">
                                <Avatar source={user?.avatar} size={36} />
                            </View>
                            <View className="flex-1">
                                <MentionTextInput
                                    style={[styles.composerInput, {
                                        color: theme.colors.text,
                                        backgroundColor: theme.colors.background
                                    }]}
                                    placeholder={t('compose.replyPlaceholder')}
                                    value={content}
                                    onChangeText={setContent}
                                    onMentionsChange={setMentions}
                                    multiline
                                    maxLength={MAX_CHARACTERS}
                                />

                                {/* Media Preview */}
                                {mediaIds.length > 0 && (
                                    <View className="my-2">
                                        <PostAttachmentsRow
                                            media={mediaIds.map(m => ({ id: m.id, type: m.type }))}
                                            leftOffset={0}
                                        />
                                    </View>
                                )}

                                {/* Poll Creator */}
                                {showPollCreator && (
                                    <View className="mt-3 p-3 rounded-xl border border-border">
                                        <View className="flex-row items-center justify-between mb-3">
                                            <Text className="text-base font-semibold text-foreground">{t('Create a poll')}</Text>
                                            <TouchableOpacity onPress={removePoll}>
                                                <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                                            </TouchableOpacity>
                                        </View>
                                        {pollOptions.map((option, index) => (
                                            <View key={index} className="flex-row items-center gap-2 mb-2">
                                                <TextInput
                                                    style={[styles.pollOptionInput, {
                                                        borderColor: theme.colors.border,
                                                        color: theme.colors.text,
                                                        backgroundColor: theme.colors.background
                                                    }]}
                                                    placeholder={t(`Option ${index + 1}`)}
                                                    placeholderTextColor={theme.colors.textSecondary}
                                                    value={option}
                                                    onChangeText={(value) => updatePollOption(index, value)}
                                                    maxLength={50}
                                                />
                                                {pollOptions.length > 2 && (
                                                    <TouchableOpacity onPress={() => removePollOption(index)}>
                                                        <Ionicons name="close-circle" size={20} color={theme.colors.textSecondary} />
                                                    </TouchableOpacity>
                                                )}
                                            </View>
                                        ))}
                                        {pollOptions.length < 4 && (
                                            <TouchableOpacity className="flex-row items-center gap-1 py-2" onPress={addPollOption}>
                                                <Ionicons name="add" size={16} color={theme.colors.primary} />
                                                <Text className="text-sm font-medium text-primary">
                                                    {t('Add option')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                )}

                                {/* Location Display */}
                                {location && (
                                    <View className="flex-row items-center gap-2 px-3 py-2 mt-2 rounded-lg border bg-secondary border-border">
                                        <Ionicons name="location" size={16} color={theme.colors.primary} />
                                        <Text className="flex-1 text-sm text-muted-foreground" numberOfLines={1}>
                                            {location.address}
                                        </Text>
                                        <TouchableOpacity onPress={removeLocation}>
                                            <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                                        </TouchableOpacity>
                                    </View>
                                )}

                                {/* Compose Toolbar */}
                                <ComposeToolbar
                                    onMediaPress={openMediaPicker}
                                    onPollPress={openPollCreator}
                                    onLocationPress={requestLocation}
                                    hasLocation={!!location}
                                    isGettingLocation={isGettingLocation}
                                    hasPoll={showPollCreator}
                                    hasMedia={mediaIds.length > 0}
                                    disabled={isSubmitting}
                                />
                            </View>
                            <TouchableOpacity
                                onPress={handleReply}
                                disabled={!canReply}
                                style={[
                                    styles.composerButton,
                                    !canReply && styles.composerButtonDisabled
                                ]}
                                className="bg-primary"
                            >
                                <Text className="font-semibold text-sm" style={{ color: theme.colors.card }}>{isSubmitting ? '...' : 'Reply'}</Text>
                            </TouchableOpacity>
                        </View>
                        <View className="flex-row justify-end px-2 py-1">
                            <Text
                                className="text-xs"
                                style={{
                                    color: isOverLimit ? theme.colors.error : theme.colors.textSecondary,
                                    fontWeight: isOverLimit ? '600' : '400',
                                }}
                            >
                                {characterCount}/{MAX_CHARACTERS}
                            </Text>
                        </View>
                    </View>
                </ThemedView>
            </KeyboardAvoidingView>
        </>
    );
};

const styles = StyleSheet.create({
    feedContent: {
        paddingBottom: 120,
    },
    composerContainer: {
        borderTopWidth: 1,
        paddingHorizontal: 12,
        paddingTop: 8,
        backgroundColor: 'transparent',
    },
    composerInput: {
        minHeight: 40,
        maxHeight: 120,
        fontSize: 16,
        paddingVertical: 8,
    },
    pollOptionInput: {
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        fontSize: 14,
    },
    composerButton: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 16,
        alignSelf: 'flex-start',
        marginTop: 8,
    },
    composerButtonDisabled: {
        opacity: 0.5,
    },
});

export default PostDetailScreen;
