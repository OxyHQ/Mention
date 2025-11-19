import React, { useRef, useMemo, useCallback, useEffect } from 'react';
import { Image, ScrollView, StyleSheet, View, Text, GestureResponderEvent, Dimensions, Pressable, Platform, ViewStyle } from 'react-native';
import PollCard from './PollCard';
import { useOxy } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
// Dynamic import to break circular dependency: PostItem -> PostMiddle -> PostItem
// Using a function to lazily require PostItem only when needed
let PostItemComponent: React.ComponentType<any> | null = null;
const getPostItem = () => {
  if (!PostItemComponent) {
    PostItemComponent = require('../Feed/PostItem').default;
  }
  return PostItemComponent;
};
import { useTheme } from '@/hooks/useTheme';
import { GeoJSONPoint, PostAttachmentDescriptor, PostSourceLink } from '@mention/shared-types';
import PostLocation from './PostLocation';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useRouter } from 'expo-router';
import PostArticlePreview from './PostArticlePreview';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { LinkPreview } from '../Compose/LinkPreview';

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

interface MediaObj { id: string; type: 'image' | 'video' | 'gif' }
interface Props {
  media?: MediaObj[];
  attachments?: PostAttachmentDescriptor[];
  nestedPost?: any; // original (repost) or parent (reply)
  leftOffset?: number; // negative margin-left to offset avatar space
  pollId?: string;
  pollData?: any; // Direct poll data from content.poll
  nestingDepth?: number; // Track nesting depth to prevent infinite nesting
  postId?: string; // Post ID for navigation to videos screen
  article?: { articleId?: string; title?: string; body?: string } | null;
  onArticlePress?: (() => void) | null;
  location?: GeoJSONPoint | null;
  sources?: PostSourceLink[];
  onSourcesPress?: (() => void) | null;
  text?: string; // Post text to extract links from
  linkMetadata?: { url: string; title?: string; description?: string; image?: string; siteName?: string } | null; // Link metadata if available
}

// Video item component to properly use the hook
const VideoItem: React.FC<{ 
  src: string; 
  containerStyle?: any; 
  borderColor: string; 
  backgroundColor: string;
  postId?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean; // If true, remove max height constraint
  hasMultipleMedia?: boolean; // If true, use fixed height with width determined by aspect ratio
}> = ({ src, containerStyle, borderColor, backgroundColor, postId, onPress, hasSingleMedia, hasMultipleMedia }) => {
  const player = useVideoPlayer(src, (player) => {
    if (player) {
      player.loop = true;
      player.muted = true;
    }
  });

  // Autoplay video when component mounts
  useEffect(() => {
    if (player) {
      const playVideo = async () => {
        try {
          await player.play();
        } catch (error) {
          // Autoplay may be blocked - silently handle
        }
      };
      playVideo();
    }
    return () => {
      if (player) {
        try {
          player.pause();
        } catch (error) {
          // Silently handle pause errors
        }
      }
    };
  }, [player]);

  return (
    <Pressable 
      onPress={onPress}
      style={({ pressed }) => [
        { opacity: pressed ? 0.9 : 1 },
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' }
      ]}
    >
      <View style={[
        styles.itemContainer,
        webGrabCursorStyle,
        { borderColor, backgroundColor },
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' },
        hasSingleMedia && { maxHeight: undefined, height: undefined }
      ]}>
        <VideoView
          player={player}
          style={hasSingleMedia ? styles.videoPreserveAspect : styles.videoMultipleMedia}
          contentFit="contain"
          nativeControls={false}
          allowsFullscreen={false}
          allowsPictureInPicture={false}
          pointerEvents="none"
        />
      </View>
    </Pressable>
  );
};

const PostMiddle: React.FC<Props> = React.memo(({ media, attachments, nestedPost, leftOffset = 0, pollId, pollData, nestingDepth = 0, postId, article, onArticlePress, text, linkMetadata }) => {
  const theme = useTheme();
  const router = useRouter();
  const { oxyServices } = useOxy();

  const mediaArray = useMemo(() => Array.isArray(media) ? media : [], [media]);
  const attachmentDescriptors = useMemo(() => Array.isArray(attachments) ? attachments : [], [attachments]);

  const hasPoll = useMemo(() => Boolean(pollId || pollData), [pollId, pollData]);
  const hasArticle = useMemo(() => Boolean(article && ((article.title?.trim?.() || article.body?.trim?.()))), [article]);
  const hasLink = useMemo(() => Boolean(linkMetadata?.url), [linkMetadata]);

  const resolveMediaSrc = useCallback((id: string) => {
    if (!id) return '';
    try {
      return oxyServices?.getFileDownloadUrl?.(id) ?? id;
    } catch {
      return id;
    }
  }, [oxyServices]);

  type AttachmentItem =
    | { type: 'poll' }
    | { type: 'article' }
    | { type: 'link'; url: string; title?: string; description?: string; image?: string; siteName?: string }
    | { type: 'video'; mediaId: string; src: string }
    | { type: 'image'; mediaId: string; src: string; mediaType: 'image' | 'gif' };

  const attachmentItems = useMemo(() => {
    const results: AttachmentItem[] = [];
    const mediaById = new Map<string, MediaObj>();
    const usedMedia = new Set<string>();

    mediaArray.forEach((m) => {
      if (m?.id) {
        mediaById.set(String(m.id), m);
      }
    });

    const addMediaItem = (mediaId: string, explicitType?: 'image' | 'video' | 'gif') => {
      const id = String(mediaId || '');
      if (!id || usedMedia.has(id)) return;
      const mediaItem = mediaById.get(id);
      if (!mediaItem) return;
      usedMedia.add(id);
      const resolvedType = explicitType || mediaItem.type || 'image';
      const src = resolveMediaSrc(id);
      if (!src) return;
      if (resolvedType === 'video') {
        results.push({ type: 'video', mediaId: id, src });
      } else {
        const kind = resolvedType === 'gif' ? 'gif' : 'image';
        results.push({ type: 'image', mediaId: id, src, mediaType: kind });
      }
    };

    if (attachmentDescriptors.length) {
      attachmentDescriptors.forEach((descriptor) => {
        if (!descriptor) return;
        switch (descriptor.type) {
          case 'poll':
            if (hasPoll && !results.some(item => item.type === 'poll')) {
              results.push({ type: 'poll' });
            }
            break;
          case 'article':
            if (hasArticle && !results.some(item => item.type === 'article')) {
              results.push({ type: 'article' });
            }
            break;
          case 'link':
            if (hasLink && linkMetadata && !results.some(item => item.type === 'link')) {
              results.push({ 
                type: 'link', 
                url: linkMetadata.url,
                title: linkMetadata.title,
                description: linkMetadata.description,
                image: linkMetadata.image,
                siteName: linkMetadata.siteName,
              });
            }
            break;
          case 'media':
            if (descriptor.id) {
              addMediaItem(descriptor.id, descriptor.mediaType as any);
            }
            break;
          default:
            break;
        }
      });
    } else {
      // If no attachment descriptors, add items in default order
      if (hasPoll) results.push({ type: 'poll' });
      if (hasArticle) results.push({ type: 'article' });
      if (hasLink && linkMetadata) {
        results.push({ 
          type: 'link', 
          url: linkMetadata.url,
          title: linkMetadata.title,
          description: linkMetadata.description,
          image: linkMetadata.image,
          siteName: linkMetadata.siteName,
        });
      }
    }
    
    // Process any remaining media from mediaArray that wasn't in descriptors
    mediaArray.forEach((m) => {
      if (!m?.id) return;
      const id = String(m.id);
      if (usedMedia.has(id)) return;
      addMediaItem(id, m.type);
    });

    // Always add link if detected, even if not in attachment descriptors
    // This ensures links are shown even if they weren't saved in attachments
    // Links aren't saved in the backend attachment schema, so we detect them from text
    // Insert link AFTER all media processing so we know the final media positions
    if (hasLink && linkMetadata && !results.some(item => item.type === 'link')) {
      const linkItem: AttachmentItem = { 
        type: 'link', 
        url: linkMetadata.url,
        title: linkMetadata.title,
        description: linkMetadata.description,
        image: linkMetadata.image,
        siteName: linkMetadata.siteName,
      };
      
      // Find the best position to insert the link:
      // 1. After poll/article (if they exist)
      // 2. Before first media (if media exists)
      // 3. At the end (if no media)
      let insertIdx = -1;
      
      // Find last poll/article index
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].type === 'poll' || results[i].type === 'article') {
          insertIdx = i + 1;
          break;
        }
      }
      
      // If no poll/article, find first media index
      if (insertIdx === -1) {
        const firstMediaIdx = results.findIndex(item => item.type === 'image' || item.type === 'video');
        insertIdx = firstMediaIdx !== -1 ? firstMediaIdx : results.length;
      }
      
      results.splice(insertIdx, 0, linkItem);
    }

    return results;
  }, [attachmentDescriptors, mediaArray, hasPoll, hasArticle, hasLink, linkMetadata, resolveMediaSrc]);

  type Item =
    | { type: 'nested' }
    | AttachmentItem;

  const items = useMemo(() => {
    const computed: Item[] = [...attachmentItems];
    const shouldIncludeNested = nestedPost && nestingDepth < 2;
    if (shouldIncludeNested) {
      const firstMediaIdx = computed.findIndex(item => item.type === 'image' || item.type === 'video');
      const nestedItem: Item = { type: 'nested' };
      if (firstMediaIdx === -1) {
        computed.push(nestedItem);
      } else {
        computed.splice(firstMediaIdx, 0, nestedItem);
      }
    }
    return computed;
  }, [attachmentItems, nestedPost, nestingDepth]);

  const mediaItems = useMemo(() =>
    items.filter((item): item is Extract<Item, { type: 'image' | 'video' }> => item.type === 'image' || item.type === 'video'),
  [items]);

  const videoItems = useMemo(() => mediaItems.filter(item => item.type === 'video'), [mediaItems]);
  const hasSingleVideo = videoItems.length === 1 && mediaItems.length === 1;
  const hasMultipleMedia = mediaItems.length > 1;
  const hasExactlyOneMedia = mediaItems.length === 1;
  const hasSingleMedia = mediaItems.length === 1 && !items.some(item => item.type === 'poll' || item.type === 'article' || item.type === 'nested');

  const handleVideoPress = useCallback(() => {
    if (postId && hasSingleVideo) {
      router.push(`/videos?postId=${postId}`);
    }
  }, [postId, hasSingleVideo, router]);

  const screenWidth = Dimensions.get('window').width;
  const [scrollViewWidth, setScrollViewWidth] = React.useState(screenWidth);

  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const scrollViewRef = useRef<ScrollView | null>(null);

  const onTouchStart = (e: GestureResponderEvent) => {
    const t = e.nativeEvent.touches && e.nativeEvent.touches[0];
    if (t) {
      startX.current = t.pageX;
      startY.current = t.pageY;
    }
  };

  const onMoveShouldSetResponderCapture = (e: GestureResponderEvent) => {
    const t = e.nativeEvent.touches && e.nativeEvent.touches[0];
    if (!t || startX.current === null || startY.current === null) return false;
    const dx = Math.abs(t.pageX - startX.current);
    const dy = Math.abs(t.pageY - startY.current);
    // capture when the gesture is predominantly horizontal
    return dx > dy && dx > 5;
  };

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const scrollView = scrollViewRef.current as unknown as {
      getScrollableNode?: () => unknown;
      _node?: unknown;
    } | null;
    const node = scrollView?.getScrollableNode?.() ?? scrollView?._node ?? scrollViewRef.current;
    if (!node || !(node as any).addEventListener) return;
    const element = node as unknown as HTMLElement;

    let isDragging = false;
    let startXPos = 0;
    let startScrollLeft = 0;

    const setCursor = (value: string) => {
      element.style.cursor = value;
    };

    setCursor('grab');

    const handleMouseDown = (event: any) => {
      isDragging = true;
      startXPos = event.pageX;
      startScrollLeft = element.scrollLeft;
      setCursor('grabbing');
      element.style.userSelect = 'none';
    };

    const stopDragging = () => {
      if (!isDragging) return;
      isDragging = false;
      setCursor('grab');
      element.style.removeProperty('user-select');
    };

    const handleMouseMove = (event: any) => {
      if (!isDragging) return;
      event.preventDefault();
      const x = event.pageX;
      const walk = x - startXPos;
      element.scrollLeft = startScrollLeft - walk;
    };

    element.addEventListener('mousedown', handleMouseDown);
    element.addEventListener('mouseleave', stopDragging);
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      element.removeEventListener('mousedown', handleMouseDown);
      element.removeEventListener('mouseleave', stopDragging);
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('mousemove', handleMouseMove);
      element.style.cursor = '';
      element.style.removeProperty('user-select');
    };
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      // allow nested scrolling on Android and improve horizontal gesture handling on native
      nestedScrollEnabled={true}
      directionalLockEnabled={true}
      // capture horizontal gestures when drag is mostly horizontal so this scrollview wins
      onTouchStart={onTouchStart}
      onMoveShouldSetResponderCapture={onMoveShouldSetResponderCapture}
      // try to capture responder at start so parent pressables/lists don't steal the gesture
      onStartShouldSetResponderCapture={() => true}
      onStartShouldSetResponder={() => true}
      onLayout={(e) => setScrollViewWidth(e.nativeEvent.layout.width)}
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.scroller, { backgroundColor: theme.colors.background }, leftOffset ? { paddingLeft: leftOffset } : null]}
    >
      {items.map((item, idx) => {
        if (item.type === 'article') {
          const trimmedTitle = article?.title?.trim();
          const trimmedBody = article?.body?.trim();
          return (
            <PostArticlePreview
              key={`article-${idx}`}
              title={trimmedTitle}
              body={trimmedBody}
              onPress={onArticlePress || undefined}
            />
          );
        }
        if (item.type === 'link') {
          return (
            <View
              key={`link-${idx}`}
              style={[styles.itemContainer, webGrabCursorStyle, styles.linkWrapper, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
            >
              <LinkPreview
                link={{
                  url: item.url,
                  title: item.title,
                  description: item.description,
                  image: item.image,
                  siteName: item.siteName,
                  fetchedAt: Date.now(),
                }}
              />
            </View>
          );
        }
        if (item.type === 'poll') {
          return (
            <View
              key={`poll-${idx}`}
              style={[styles.itemContainer, webGrabCursorStyle, styles.pollWrapper, { borderColor: theme.colors.border }]}
            >
              {pollId ? (
                // Use interactive PollCard when we have a pollId
                <PollCard pollId={pollId as string} />
              ) : pollData ? (
                // Fallback to simple display if we only have poll data without ID
                <View style={[styles.pollContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Text style={[styles.pollQuestion, { color: theme.colors.text }]}>{pollData.question}</Text>
                  {pollData.options?.map((option: string, optIdx: number) => (
                    <View key={optIdx} style={[styles.pollOption, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
                      <Text style={[styles.pollOptionText, { color: theme.colors.text }]}>{option}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                // Debug: Show what we received
                <View style={[styles.pollContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Text style={[styles.pollQuestion, { color: theme.colors.error }]}>
                    {process.env.NODE_ENV === 'development' ? 'Poll data missing' : 'Poll unavailable'}
                  </Text>
                </View>
              )}
            </View>
          );
        }
        if (item.type === 'nested') {
          // Render PostItem with dynamic require to break circular dependency
          // Pass nesting depth to prevent infinite recursion
          // Use the measured ScrollView width minus the applied paddings
          const scrollerPaddingRight = 12; // from styles.scroller
          const scrollerPaddingLeft = Math.abs(leftOffset); // applied via contentContainerStyle
          const nestedWidth = scrollViewWidth - scrollerPaddingLeft - scrollerPaddingRight;
          const PostItem = getPostItem();
          if (!PostItem) return null;
          return (
            <View key={`nested-${idx}`} style={[styles.nestedContainer, { width: nestedWidth }]}>
              <PostItem post={nestedPost} isNested={true} nestingDepth={nestingDepth + 1} />
            </View>
          );
        }
        if (item.type === 'video') {
          return (
            <VideoItem
              key={`video-${item.mediaId ?? idx}`}
              src={item.src}
              containerStyle={[]}
              borderColor={theme.colors.border}
              backgroundColor={theme.colors.backgroundSecondary}
              postId={postId}
              onPress={hasSingleVideo ? handleVideoPress : undefined}
              hasSingleMedia={hasSingleMedia}
              hasMultipleMedia={hasMultipleMedia}
            />
          );
        }
        if (item.type === 'image') {
          // For single media, also calculate aspect ratio to prevent 0 height issues
          // This is especially important when location data is present
          // Use hasExactlyOneMedia to handle cases where there's also a poll or nestedPost
          const imageSrc = item.src;
          const imageKey = item.mediaId ?? idx;
          const ImageWithAspectRatio = hasExactlyOneMedia && !hasMultipleMedia ? (() => {
            const ImageWithRatio: React.FC<{ src: string }> = ({ src }) => {
              const [aspectRatio, setAspectRatio] = React.useState<number | undefined>(undefined);

              React.useEffect(() => {
                Image.getSize(
                  src,
                  (width, height) => {
                    if (width > 0 && height > 0) {
                      setAspectRatio(width / height);
                    }
                  },
                  () => {
                    // On error, use default aspect ratio
                    setAspectRatio(4 / 3);
                  }
                );
              }, [src]);

              return (
                <View style={[
                  styles.itemContainer,
                  webGrabCursorStyle,
                  { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary },
                  { maxHeight: undefined, height: undefined }
                ]}>
                  <Image
                    source={{ uri: src }}
                    style={[
                      styles.imagePreserveAspect,
                      aspectRatio !== undefined ? { aspectRatio } : undefined
                    ]}
                    resizeMode="contain"
                  />
                </View>
              );
            };
            return <ImageWithRatio key={`img-${imageKey}`} src={imageSrc} />;
          })() : hasMultipleMedia ? (() => {
            const ImageWithRatio: React.FC<{ src: string }> = ({ src }) => {
              const [aspectRatio, setAspectRatio] = React.useState<number | undefined>(undefined);

              React.useEffect(() => {
                Image.getSize(
                  src,
                  (width, height) => {
                    if (width > 0 && height > 0) {
                      setAspectRatio(width / height);
                    }
                  },
                  () => {
                    // On error, use default
                    setAspectRatio(4 / 3);
                  }
                );
              }, [src]);

              return (
                <View style={[
                  styles.itemContainer,
                  webGrabCursorStyle,
                  { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary },
                  { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' }
                ]}>
                  <Image
                    source={{ uri: src }}
                    style={[
                      styles.imageMultipleMedia,
                      aspectRatio !== undefined ? { aspectRatio } : undefined
                    ]}
                    resizeMode="contain"
                  />
                </View>
              );
            };
            return <ImageWithRatio key={`img-${imageKey}`} src={imageSrc} />;
          })() : (() => {
            // Fallback: Always render with aspect ratio to prevent 0 height issues
            // This handles edge cases where media count doesn't match expected conditions
            const ImageWithRatio: React.FC<{ src: string }> = ({ src }) => {
              const [aspectRatio, setAspectRatio] = React.useState<number | undefined>(undefined);

              React.useEffect(() => {
                Image.getSize(
                  src,
                  (width, height) => {
                    if (width > 0 && height > 0) {
                      setAspectRatio(width / height);
                    }
                  },
                  () => {
                    // On error, use default aspect ratio
                    setAspectRatio(4 / 3);
                  }
                );
              }, [src]);

              return (
                <View style={[
                  styles.itemContainer,
                  webGrabCursorStyle,
                  { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary },
                  { maxHeight: undefined, height: undefined }
                ]}>
                  <Image
                    source={{ uri: src }}
                    style={[
                      styles.imagePreserveAspect,
                      aspectRatio !== undefined ? { aspectRatio } : undefined
                    ]}
                    resizeMode="contain"
                  />
                </View>
              );
            };
            return <ImageWithRatio key={`img-${imageKey}`} src={imageSrc} />;
          })();

          return ImageWithAspectRatio;
        }
        return null;
      })}
    </ScrollView>
  );
}, (prevProps, nextProps) => {
  // Custom comparison for memo - only re-render if props actually change
  return (
    prevProps.media === nextProps.media &&
    prevProps.attachments === nextProps.attachments &&
    prevProps.nestedPost === nextProps.nestedPost &&
    prevProps.leftOffset === nextProps.leftOffset &&
    prevProps.pollId === nextProps.pollId &&
    prevProps.pollData === nextProps.pollData &&
    prevProps.nestingDepth === nextProps.nestingDepth &&
    prevProps.postId === nextProps.postId &&
    prevProps.article === nextProps.article &&
    prevProps.onArticlePress === nextProps.onArticlePress &&
    prevProps.text === nextProps.text &&
    prevProps.linkMetadata?.url === nextProps.linkMetadata?.url &&
    prevProps.location === nextProps.location &&
    prevProps.sources === nextProps.sources &&
    prevProps.onSourcesPress === nextProps.onSourcesPress
  );
});

export default PostMiddle;

const CARD_WIDTH = 280;
const CARD_HEIGHT = 180;

const styles = StyleSheet.create({
  scroller: {
    paddingRight: 12,
    gap: 12,
  },
  itemContainer: {
    borderWidth: 1,
    borderRadius: 15,
    overflow: 'hidden', // Ensure content respects border radius
  },
  pollWrapper: {
    width: CARD_WIDTH,
  },
  linkWrapper: {
    width: CARD_WIDTH,
  },
  mediaImage: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  },
  mediaContainer: {
    width: CARD_WIDTH,
    alignSelf: 'flex-start',
    // Container wraps content - height determined by media's natural aspect ratio (single media)
  },
  mediaContainerMultiple: {
    height: CARD_HEIGHT,
    alignSelf: 'flex-start',
    // Container has fixed height - width will be determined by content (media's natural aspect ratio)
    flexShrink: 0,
  },
  video: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  },
  videoPreserveAspect: {
    width: CARD_WIDTH,
    // No height or aspectRatio constraint - height determined by video's natural aspect ratio with contentFit="contain"
  },
  videoMultipleMedia: {
    height: CARD_HEIGHT,
    // No width or aspectRatio - width will be determined by video's natural aspect ratio with contentFit="contain"
    alignSelf: 'flex-start',
  },
  imagePreserveAspect: {
    width: CARD_WIDTH,
    // No height or aspectRatio constraint - height determined by image's natural aspect ratio with resizeMode="contain"
  },
  imageMultipleMedia: {
    height: CARD_HEIGHT,
    // No width or aspectRatio - width will be determined by image's natural aspect ratio with resizeMode="contain"
    alignSelf: 'flex-start',
  },
  pollContainer: {
    padding: 16,
    borderRadius: 15,
  },
  pollQuestion: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  pollOption: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  pollOptionText: {
    fontSize: 14,
  },
  nestedContainer: {
    // Width is set dynamically to fill available space
  },
});
