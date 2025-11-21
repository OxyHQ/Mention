import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    Alert,
    TouchableOpacity,
    KeyboardAvoidingView,
    Platform,
    TextInput,
    Image,
    ScrollView
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { colors } from '../../styles/colors';
import PostItem from '../../components/Feed/PostItem';
import Feed from '../../components/Feed/Feed';
import PostAttachmentsRow from '../../components/Post/PostAttachmentsRow';
import { usePostsStore } from '../../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import { UIPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import { useOxy } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import ComposeToolbar from '@/components/ComposeToolbar';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import MentionTextInput, { MentionData } from '@/components/MentionTextInput';
import { statisticsService } from '@/services/statisticsService';
import SEO from '@/components/SEO';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
//

const MAX_CHARACTERS = 280;

const PostDetailScreen: React.FC = () => {
    const { id } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const { getPostById, createReply } = usePostsStore();
    const { user, showBottomSheet, oxyServices } = useOxy();
    const theme = useTheme();
    const { t } = useTranslation();
    const { handleScroll, scrollEventThrottle, registerScrollable } = useLayoutScroll();
    const scrollViewRef = useRef<ScrollView>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);

    const [post, setPost] = useState<UIPost | Reply | Repost | null>(null);
    const [parentPost, setParentPost] = useState<UIPost | Reply | Repost | null>(null);
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

    // Register scrollable with LayoutScrollContext
    useEffect(() => {
        if (scrollViewRef.current) {
            unregisterScrollableRef.current = registerScrollable(scrollViewRef.current);
        }
        return () => {
            if (unregisterScrollableRef.current) {
                unregisterScrollableRef.current();
                unregisterScrollableRef.current = null;
            }
        };
    }, [registerScrollable]);

    const handleScrollEvent = useCallback((event: any) => {
        if (handleScroll) {
            handleScroll(event);
        }
    }, [handleScroll]);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const hasContent = content.trim().length > 0 || mediaIds.length > 0 || (pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0));
    const canReply = hasContent && !isOverLimit && !isSubmitting;

    // Memoize filters to prevent Feed re-renders on every keystroke
    const feedFilters = useMemo(() => ({
        postId: String(id),
        parentPostId: String(id)
    }), [id]);

    // Memoize contentContainerStyle to prevent Feed re-renders
    const feedContentStyle = useMemo(() => ({
        paddingBottom: 16
    }), []);

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
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') {
                toast.error(t('Location permission denied'));
                return;
            }

            const currentLocation = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
            });

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
                            // Parent not cached, fetch it
                            try {
                                const parentResponse = await getPostById((cachedPost as any).parentPostId);
                                setParentPost(parentResponse);
                            } catch (parentErr) {
                                console.error('Error fetching parent post:', parentErr);
                            }
                        }
                    }
                    
                    // Track view in background (non-blocking)
                    if (user) {
                        statisticsService.trackPostView(String(id)).catch(() => {
                            // Silently fail - view tracking is not critical
                        });
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
                            console.error('Error fetching parent post:', parentErr);
                        }
                    }
                    
                    // Track post view
                    if (user) {
                        try {
                            await statisticsService.trackPostView(String(id));
                        } catch (viewErr) {
                            console.debug('Failed to track post view:', viewErr);
                        }
                    }
                }
            } catch (err) {
                console.error('Error loading post:', err);
                setError('Failed to load post');
            } finally {
                setLoading(false);
            }
        };

        loadPost();
    }, [id, getPostById, user]);

    const handleBack = () => {
        router.back();
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

    const postText = (post as any)?.content?.text || '';
    const postDescription = postText.length > 200 
        ? `${postText.substring(0, 197)}...` 
        : postText || t('seo.post.description', { defaultValue: 'View this post on Mention' });
    const postAuthor = (post as any)?.user?.name || (post as any)?.user?.handle || t('common.someone');
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
                } as any,
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
            console.error('Failed to post reply:', error);
            toast.error(t('Failed to post reply. Please try again.'));
        } finally {
            setIsSubmitting(false);
        }
    };

    // No local replies state; Feed handles loading with filters



    if (loading) {
        return (
            <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
                <Header
                    options={{
                        title: 'Post',
                        leftComponents: [
                            <HeaderIconButton
                                key="back"
                                onPress={handleBack}
                            >
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </HeaderIconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                    <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>Loading post...</Text>
                </View>
            </ThemedView>
        );
    }

    if (error || !post) {
        return (
            <>
                <SEO
                    title={t('seo.post.notFound')}
                    description={t('seo.post.notFoundDescription')}
                />
                <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
                    <Header
                        options={{
                            title: 'Post',
                            leftComponents: [
                                <HeaderIconButton
                                    key="back"
                                    onPress={handleBack}
                                >
                                    <BackArrowIcon size={20} color={theme.colors.text} />
                                </HeaderIconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                    <View style={styles.errorContainer}>
                        <Ionicons name="alert-circle-outline" size={48} color={theme.colors.error} />
                        <Text style={[styles.errorTitle, { color: theme.colors.text }]}>Post Not Found</Text>
                        <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>
                            {error || 'The post you\'re looking for doesn\'t exist or has been deleted.'}
                        </Text>
                        <TouchableOpacity style={[styles.retryButton, { backgroundColor: theme.colors.primary }]} onPress={() => router.back()}>
                            <Text style={[styles.retryButtonText, { color: theme.colors.card }]}>Go Back</Text>
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
                publishedTime={(post as any)?.createdAt}
                modifiedTime={(post as any)?.updatedAt}
            />
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 56 : 0}
                style={[styles.container, { paddingTop: insets.top }]}
            >
                <Header
                    options={{
                        title: post?.isThread ? 'Thread' : 'Post',
                        leftComponents: [
                            <HeaderIconButton
                                key="back"
                                onPress={handleBack}
                            >
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </HeaderIconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />

            <ScrollView
                ref={scrollViewRef}
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                onScroll={handleScrollEvent}
                scrollEventThrottle={scrollEventThrottle}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled={true}
                {...(Platform.OS === 'web' ? { 'data-layoutscroll': 'true' } : {})}
            >
                {/* Show parent post on top if this is a reply */}
                {parentPost && (post as any)?.parentPostId && (
                    <View style={[styles.parentPostContainer, { borderBottomColor: theme.colors.border }]}>
                        <Text style={[styles.parentPostLabel, { color: theme.colors.textSecondary }]}>Replying to</Text>
                        <PostItem
                            post={parentPost}
                            onReply={handleFocusInput}
                        />
                        <View style={[styles.replyConnector, { backgroundColor: theme.colors.border }]} />
                    </View>
                )}

                <View style={styles.postContainer}>
                    <PostItem
                        post={post}
                        onReply={handleFocusInput}
                    />
                </View>
                <View style={styles.repliesSection}>
                    <Text style={[styles.repliesTitle, { color: theme.colors.text }]}>Replies</Text>
                    <Feed
                        type={'replies' as any}
                        hideHeader={true}
                        style={styles.repliesFeed}
                        contentContainerStyle={feedContentStyle}
                        filters={feedFilters}
                        reloadKey={repliesReloadKey}
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                        scrollEnabled={false}
                    />
                </View>
            </ScrollView>

            {/* Inline Reply Composer */}
            <ThemedView style={[styles.composerContainer, { borderTopColor: theme.colors.border, paddingBottom: Math.max(insets.bottom, 8) }]}
            >
                <View style={styles.composerContent}>
                    <View style={styles.composer}>
                        <View style={styles.composerAvatarWrap}>
                            <Image
                                source={{ uri: (user as any)?.avatar || 'https://via.placeholder.com/40' }}
                                style={[styles.composerAvatar, { backgroundColor: theme.colors.backgroundSecondary }]}
                            />
                        </View>
                        <View style={styles.composerInputContainer}>
                            <MentionTextInput
                                style={[styles.composerInput, {
                                    color: theme.colors.text,
                                    backgroundColor: theme.colors.background
                                }]}
                                placeholder="Post your reply"
                                value={content}
                                onChangeText={setContent}
                                onMentionsChange={setMentions}
                                multiline
                                maxLength={MAX_CHARACTERS}
                            />

                            {/* Media Preview */}
                            {mediaIds.length > 0 && (
                                <View style={styles.mediaPreview}>
                                    <PostAttachmentsRow
                                        media={mediaIds.map(m => ({ id: m.id, type: m.type }))}
                                        leftOffset={0}
                                    />
                                </View>
                            )}

                            {/* Poll Creator */}
                            {showPollCreator && (
                                <View style={[styles.pollCreator, { borderColor: theme.colors.border }]}>
                                    <View style={styles.pollHeader}>
                                        <Text style={[styles.pollTitle, { color: theme.colors.text }]}>{t('Create a poll')}</Text>
                                        <TouchableOpacity onPress={removePoll}>
                                            <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                                        </TouchableOpacity>
                                    </View>
                                    {pollOptions.map((option, index) => (
                                        <View key={index} style={styles.pollOptionRow}>
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
                                        <TouchableOpacity style={styles.addPollOptionBtn} onPress={addPollOption}>
                                            <Ionicons name="add" size={16} color={theme.colors.primary} />
                                            <Text style={[styles.addPollOptionText, { color: theme.colors.primary }]}>
                                                {t('Add option')}
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            )}

                            {/* Location Display */}
                            {location && (
                                <View style={[styles.locationDisplay, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
                                    <Ionicons name="location" size={16} color={theme.colors.primary} />
                                    <Text style={[styles.locationText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
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
                                { backgroundColor: theme.colors.primary },
                                !canReply && styles.composerButtonDisabled
                            ]}
                        >
                            <Text style={[styles.composerButtonText, { color: theme.colors.card }]}>{isSubmitting ? '...' : 'Reply'}</Text>
                        </TouchableOpacity>
                    </View>
                    <View style={styles.composerMeta}>
                        <Text
                            style={[
                                styles.characterCountText,
                                { color: theme.colors.textSecondary },
                                isOverLimit && [styles.characterCountWarning, { color: theme.colors.error }]
                            ]}
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
    container: {
        flex: 1,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        flexGrow: 1,
        // Add extra padding to account for composer container at bottom
        paddingBottom: 120,
    },
    list: {
        flex: 1,
    },
    postContainer: {
        paddingBottom: 8,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    errorTitle: {
        fontSize: 20,
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
    },
    errorText: {
        fontSize: 16,
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: 24,
    },
    retryButton: {
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
    },
    retryButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    repliesSection: {
        minHeight: 200,
    },
    repliesTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12,
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    repliesFeed: {
        minHeight: 200,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 16,
    },
    footerText: {
        fontSize: 14,
        marginLeft: 8,
    },
    composerContainer: {
        borderTopWidth: 1,
        paddingHorizontal: 12,
        paddingTop: 8,
        backgroundColor: 'transparent',
    },
    composerContent: {
        // Removed flex: 1 to prevent layout issues - container should size to content
    },
    composer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    composerAvatarWrap: {
        paddingTop: 8,
    },
    composerAvatar: {
        width: 36,
        height: 36,
        borderRadius: 18,
    },
    composerInputContainer: {
        flex: 1,
    },
    composerInput: {
        minHeight: 40,
        maxHeight: 120,
        fontSize: 16,
        paddingVertical: 8,
    },
    mediaPreview: {
        marginTop: 8,
        marginBottom: 8,
    },
    pollCreator: {
        marginTop: 12,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
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
    },
    pollOptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
    },
    pollOptionInput: {
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        fontSize: 14,
    },
    addPollOptionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 8,
    },
    addPollOptionText: {
        fontSize: 14,
        fontWeight: '500',
    },
    locationDisplay: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginTop: 8,
        borderRadius: 8,
        borderWidth: 1,
    },
    locationText: {
        flex: 1,
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
    composerButtonText: {
        fontWeight: '600',
        fontSize: 14,
    },
    composerMeta: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 4,
    },
    characterCountText: {
        fontSize: 12,
    },
    characterCountWarning: {
        fontWeight: '600',
    },
    parentPostContainer: {
        borderBottomWidth: 1,
        paddingBottom: 12,
        marginBottom: 8,
    },
    parentPostLabel: {
        fontSize: 14,
        paddingHorizontal: 16,
        paddingVertical: 8,
        fontWeight: '500',
    },
    replyConnector: {
        width: 2,
        height: 12,
        marginLeft: 32,
        marginTop: 4,
    },
});

export default PostDetailScreen;
