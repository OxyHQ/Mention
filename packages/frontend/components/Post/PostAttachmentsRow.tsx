import React, { useRef, useMemo, useCallback, useEffect } from 'react';
import { ScrollView, StyleSheet, GestureResponderEvent, Dimensions, Platform, ViewStyle, StyleProp } from 'react-native';
import { useOxy } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { GeoJSONPoint, PostAttachmentDescriptor, PostSourceLink } from '@mention/shared-types';
import { useRouter } from 'expo-router';
import {
  PostAttachmentArticle,
  PostAttachmentLink,
  PostAttachmentMedia,
  PostAttachmentPoll,
  PostAttachmentNested,
} from './Attachments';

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
  style?: ViewStyle; // Optional style prop for margin/padding
}

type AttachmentItem =
  | { type: 'poll' }
  | { type: 'article' }
  | { type: 'link'; url: string; title?: string; description?: string; image?: string; siteName?: string }
  | { type: 'video'; mediaId: string; src: string }
  | { type: 'image'; mediaId: string; src: string; mediaType: 'image' | 'gif' };

const PostAttachmentsRow: React.FC<Props> = React.memo(({ 
  media, 
  attachments, 
  nestedPost, 
  leftOffset = 0, 
  pollId, 
  pollData, 
  nestingDepth = 0, 
  postId, 
  article, 
  onArticlePress, 
  text, 
  linkMetadata,
  style
}) => {
  const theme = useTheme();
  const router = useRouter();
  const { oxyServices } = useOxy();

  const mediaArray = useMemo(() => Array.isArray(media) ? media : [], [media]);
  const attachmentDescriptors = useMemo(() => Array.isArray(attachments) ? attachments : [], [attachments]);

  const hasPoll = useMemo(() => Boolean(pollId || pollData), [pollId, pollData]);
  const hasArticle = useMemo(() => Boolean(article && ((article.title?.trim?.() || article.body?.trim?.()))), [article]);
  const hasLink = useMemo(() => Boolean(linkMetadata?.url), [linkMetadata]);

  const resolveMediaSrc = useCallback((id: string, variant: 'thumb' | 'full' = 'thumb') => {
    if (!id) return '';
    try {
      return oxyServices?.getFileDownloadUrl?.(id, variant) ?? id;
    } catch {
      return id;
    }
  }, [oxyServices]);

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
      // Use thumbnail for images in feed, full size only when needed (e.g., detail view)
      const variant = resolvedType === 'video' ? 'full' : 'thumb';
      const src = resolveMediaSrc(id, variant);
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
    if (hasLink && linkMetadata && !results.some(item => item.type === 'link')) {
      const linkItem: AttachmentItem = { 
        type: 'link', 
        url: linkMetadata.url,
        title: linkMetadata.title,
        description: linkMetadata.description,
        image: linkMetadata.image,
        siteName: linkMetadata.siteName,
      };
      
      // Find the best position to insert the link
      let insertIdx = -1;
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].type === 'poll' || results[i].type === 'article') {
          insertIdx = i + 1;
          break;
        }
      }
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

  const scrollerPaddingRight = 12;
  const scrollerPaddingLeft = Math.abs(leftOffset);
  const nestedWidth = scrollViewWidth - scrollerPaddingLeft - scrollerPaddingRight;

  return (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      nestedScrollEnabled={true}
      directionalLockEnabled={true}
      onTouchStart={onTouchStart}
      onMoveShouldSetResponderCapture={onMoveShouldSetResponderCapture}
      onStartShouldSetResponderCapture={() => true}
      onStartShouldSetResponder={() => true}
      onLayout={(e) => setScrollViewWidth(e.nativeEvent.layout.width)}
      style={[{ backgroundColor: theme.colors.background }, style]}
      contentContainerStyle={[styles.scroller, { backgroundColor: theme.colors.background }, leftOffset ? { paddingLeft: leftOffset } : null]}
    >
      {items.map((item, idx) => {
        if (item.type === 'article') {
          return (
            <PostAttachmentArticle
              key={`article-${idx}`}
              title={article?.title?.trim()}
              body={article?.body?.trim()}
              onPress={onArticlePress || undefined}
            />
          );
        }
        if (item.type === 'link') {
          return (
            <PostAttachmentLink
              key={`link-${idx}`}
              url={item.url}
              title={item.title}
              description={item.description}
              image={item.image}
              siteName={item.siteName}
            />
          );
        }
        if (item.type === 'poll') {
          return (
            <PostAttachmentPoll
              key={`poll-${idx}`}
              pollId={pollId}
              pollData={pollData}
            />
          );
        }
        if (item.type === 'nested') {
          return (
            <PostAttachmentNested
              key={`nested-${idx}`}
              nestedPost={nestedPost}
              nestingDepth={nestingDepth}
              width={nestedWidth}
            />
          );
        }
        if (item.type === 'video' || item.type === 'image') {
          return (
            <PostAttachmentMedia
              key={`${item.type}-${item.mediaId ?? idx}`}
              type={item.type}
              src={item.src}
              mediaId={item.mediaId}
              postId={postId}
              onPress={item.type === 'video' && hasSingleVideo ? handleVideoPress : undefined}
              hasSingleMedia={hasSingleMedia}
              hasMultipleMedia={hasMultipleMedia}
            />
          );
        }
        return null;
      })}
    </ScrollView>
  );
}, (prevProps, nextProps) => {
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

const styles = StyleSheet.create({
  scroller: {
    paddingRight: 12,
    gap: 12,
  },
});

export default PostAttachmentsRow;

