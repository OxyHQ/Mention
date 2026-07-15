import React, { useRef, useMemo, useCallback, useEffect } from 'react';
import { ScrollView, StyleSheet, GestureResponderEvent, Dimensions, Platform, View, ViewStyle } from 'react-native';
import { useAuth } from '@oxyhq/services';
import {
  GeoJSONPoint,
  HydratedPostSummary,
  PollData,
  PostAttachmentDescriptor,
  PostLinkPreview,
  PostPodcastContent,
  PostSourceLink,
  MEDIA_VARIANT_THUMB,
  MEDIA_VARIANT_FULL,
} from '@mention/shared-types';
import { useRouter } from 'expo-router';
import { PodcastCard } from '@/components/Podcast/PodcastCard';
import { MEDIA_CARD_HEIGHT, MEDIA_CARD_RADIUS } from '@/utils/composeUtils';
import { getCachedFileDownloadUrlSync, videoPosterUrl } from '@/utils/imageUrlCache';
import { useImagePreload } from '@oxyhq/bloom/hooks';
import { readMediaAspectRatio } from '@/utils/mediaTypes';
import {
  ZoomableImageGallery,
  type ZoomableImageGalleryHandle,
  type GalleryImage,
  type MeasureThumb,
  type MeasuredRect,
} from '@oxyhq/bloom/zoomable-image-gallery';
import type { RegisterThumbHost } from '@/components/Post/Attachments/PostAttachmentMedia';
import {
  PostAttachmentArticle,
  PostAttachmentLink,
  PostAttachmentExternalEmbed,
  PostAttachmentMedia,
  PostAttachmentPoll,
  PostAttachmentNested,
  PostAttachmentEvent,
  PostAttachmentRoom,
} from './Attachments';
import { parseEmbedPlayerFromUrl, canEmbed, type EmbedPlayerParams } from '@/utils/embedPlayer';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';

// Runtime media reference. The server now resolves final URLs (`url`, `thumbUrl`,
// `posterUrl`, `fullUrl`); `id` remains for the legacy fallback path (old cached
// responses).
interface MediaObj {
  id: string;
  type: 'image' | 'video' | 'gif';
  /** Author-authored accessibility description (Bluesky-style "ALT"). Images only. */
  alt?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  orientation?: 'portrait' | 'landscape' | 'square';
  durationSec?: number;
  url?: string;
  thumbUrl?: string;
  posterUrl?: string;
  fullUrl?: string;
}
interface Props {
  media?: MediaObj[];
  attachments?: PostAttachmentDescriptor[];
  nestedPost?: HydratedPostSummary | null;
  leftOffset?: number;
  pollId?: string;
  pollData?: PollData | null;
  nestingDepth?: number;
  postId?: string;
  article?: { articleId?: string; title?: string; body?: string } | null;
  onArticlePress?: (() => void) | null;
  event?: { eventId?: string; name: string; date: string; location?: string; description?: string } | null;
  onEventPress?: (() => void) | null;
  room?: { roomId: string; title: string; status?: 'scheduled' | 'live' | 'ended'; topic?: string; host?: string } | null;
  onRoomPress?: (() => void) | null;
  podcast?: PostPodcastContent | null;
  location?: GeoJSONPoint | null;
  sources?: PostSourceLink[];
  onSourcesPress?: (() => void) | null;
  text?: string;
  /**
   * Resolved previews for the links in the post body, in text order (the backend
   * caps them at `MAX_POST_LINK_PREVIEWS`). Each one renders its own card; only
   * the FIRST embeddable link becomes an inline player — see `primaryEmbedIndex`.
   */
  linkPreviews?: PostLinkPreview[];
  /**
   * Per-post sensitivity flag. When true, every image/video/gif cell renders
   * behind its own blurred "Tap to reveal" cover that the viewer uncovers
   * independently. Non-media attachments (polls, links, articles…) are unaffected.
   */
  sensitive?: boolean;
  style?: ViewStyle;
}

type AttachmentItem =
  | { type: 'poll' }
  | { type: 'article' }
  | { type: 'event' }
  | { type: 'room' }
  | { type: 'podcast' }
  | { type: 'link'; url: string; title?: string; description?: string; image?: string; siteName?: string; embedParams?: EmbedPlayerParams }
  | { type: 'video'; mediaId: string; src: string; poster?: string; width?: number; height?: number; aspectRatio?: number; orientation?: 'portrait' | 'landscape' | 'square'; durationSec?: number }
  | { type: 'gif'; mediaId: string; src: string; width?: number; height?: number; aspectRatio?: number }
  | { type: 'image'; mediaId: string; src: string; fullSrc: string; mediaType: 'image' | 'gif'; alt?: string; width?: number; height?: number; aspectRatio?: number; orientation?: 'portrait' | 'landscape' | 'square' };

/**
 * The link previews of a post are identified by their URLs, in order — the rest
 * of a preview (title/image/…) is resolved server-side and never changes for a
 * given URL within a session. Compared element-wise so a re-rendered parent
 * handing over an equivalent array doesn't force the row to re-render.
 */
const areLinkPreviewsEqual = (a?: PostLinkPreview[], b?: PostLinkPreview[]): boolean => {
  if (a === b) return true;
  const prev = a ?? [];
  const next = b ?? [];
  if (prev.length !== next.length) return false;
  return prev.every((preview, index) => preview.url === next[index].url);
};

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
  event,
  onEventPress,
  room,
  onRoomPress,
  podcast,
  text,
  linkPreviews,
  sensitive,
  style
}) => {
  const router = useRouter();
  const { oxyServices } = useAuth();
  // Per-provider external-embed prefs, read once (selector) so the link branch
  // can decide between the inline player and the static card without a hook in
  // the render loop.
  const embedPrefs = useExternalEmbedsStore((state) => state.prefs);

  const mediaArray = useMemo(() => Array.isArray(media) ? media : [], [media]);
  const attachmentDescriptors = useMemo(() => Array.isArray(attachments) ? attachments : [], [attachments]);

  const hasPoll = useMemo(() => Boolean(pollId || pollData), [pollId, pollData]);
  const hasArticle = useMemo(() => Boolean(article && ((article.title?.trim?.() || article.body?.trim?.()))), [article]);
  const hasEvent = useMemo(() => Boolean(event && event.name?.trim?.()), [event]);
  const hasRoom = useMemo(() => Boolean(room?.roomId), [room]);
  const hasPodcast = useMemo(() => Boolean(podcast?.syraPodcastId), [podcast]);
  const linkPreviewArray = useMemo(() => Array.isArray(linkPreviews) ? linkPreviews.filter((preview) => Boolean(preview?.url)) : [], [linkPreviews]);

  // Resolve a media reference to a final render URL for a given context:
  //  - `thumb`: the post media card / grid thumbnail (server `thumbUrl`).
  //  - `large`: the fullscreen lightbox image (server `fullUrl`, falling back to
  //    `url`) — a larger variant than the thumb, NOT the raw original.
  //  - `playable`: the video source (server `url`).
  // Prefers the server-resolved final URLs; the legacy client resolver is only a
  // fallback for old in-memory/cached responses missing the new fields, and it
  // requests the SAME variant the server now uses for that context so the two
  // paths agree (the `MEDIA_VARIANT_*` taxonomy in `@mention/shared-types`).
  const resolveMediaSrc = useCallback((mediaItem: MediaObj, context: 'thumb' | 'large' | 'playable') => {
    const isGif = mediaItem.type === 'gif';
    if (context === 'playable') {
      const serverUrl = mediaItem.url || mediaItem.thumbUrl;
      if (serverUrl) return serverUrl;
    } else if (isGif) {
      // GIFs animate only at the no-variant original; the thumb/full image
      // variants are static first-frame webp. Prefer the original for every
      // display context (card + lightbox).
      const serverUrl = mediaItem.url || mediaItem.fullUrl || mediaItem.thumbUrl;
      if (serverUrl) return serverUrl;
    } else if (context === 'large') {
      const serverUrl = mediaItem.fullUrl || mediaItem.url || mediaItem.thumbUrl;
      if (serverUrl) return serverUrl;
    } else {
      const serverUrl = mediaItem.thumbUrl || mediaItem.url;
      if (serverUrl) return serverUrl;
    }
    const id = String(mediaItem.id || '');
    if (!id) return '';
    const fallbackVariant = (context === 'playable' || isGif)
      ? undefined
      : (context === 'large' ? MEDIA_VARIANT_FULL : MEDIA_VARIANT_THUMB);
    try {
      return getCachedFileDownloadUrlSync(oxyServices, id, fallbackVariant);
    } catch {
      return id;
    }
  }, [oxyServices]);

  const attachmentItems = useMemo(() => {
    const results: AttachmentItem[] = [];
    // One item per resolved preview, in text order. Built once; pushed by the
    // non-descriptor branch below, or inserted by the fallback for the descriptor
    // branch — the two paths are mutually exclusive.
    const linkItems: AttachmentItem[] = linkPreviewArray.map((preview) => ({
      type: 'link',
      url: preview.url,
      title: preview.title,
      description: preview.description,
      image: preview.image,
      siteName: preview.siteName,
      // Parse the embed provider once here (memoized on `linkPreviewArray`) so
      // the render loop doesn't run `new URL()` + regex on every frame.
      embedParams: parseEmbedPlayerFromUrl(preview.url),
    }));
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
      const persistedDims = {
        ...(mediaItem.width !== undefined ? { width: mediaItem.width } : {}),
        ...(mediaItem.height !== undefined ? { height: mediaItem.height } : {}),
        ...(mediaItem.aspectRatio !== undefined ? { aspectRatio: mediaItem.aspectRatio } : {}),
        ...(mediaItem.orientation !== undefined ? { orientation: mediaItem.orientation } : {}),
        ...(mediaItem.durationSec !== undefined ? { durationSec: mediaItem.durationSec } : {}),
      };
      if (resolvedType === 'video') {
        const src = resolveMediaSrc(mediaItem, 'playable');
        if (!src) return;
        // Poster: prefer the server-resolved final `posterUrl`; fall back to the
        // legacy client resolver from the RAW media id when absent (old data).
        const poster = mediaItem.posterUrl || videoPosterUrl(id, oxyServices);
        results.push({ type: 'video', mediaId: id, src, poster, ...persistedDims });
      } else if (resolvedType === 'gif') {
        // Federated gifs carry an absolute http URL as their media id — a <video>
        // can't play a remote `.gif`, so keep the animated-gif image render (via
        // the proxy). Native gifs are an Oxy fileId pointing at an mp4: render an
        // inline looping muted video (≈10–20× smaller, hardware-decoded).
        if (/^https?:\/\//i.test(id)) {
          const src = resolveMediaSrc(mediaItem, 'thumb');
          if (!src) return;
          const fullSrc = resolveMediaSrc(mediaItem, 'large') || src;
          results.push({ type: 'image', mediaId: id, src, fullSrc, mediaType: 'gif', ...persistedDims });
        } else {
          const src = resolveMediaSrc(mediaItem, 'playable');
          if (!src) return;
          results.push({ type: 'gif', mediaId: id, src, ...persistedDims });
        }
      } else {
        // Thumbnail for the in-feed card; a larger variant for the lightbox so
        // opening fullscreen upgrades the image instead of reusing the thumb.
        const src = resolveMediaSrc(mediaItem, 'thumb');
        if (!src) return;
        const fullSrc = resolveMediaSrc(mediaItem, 'large') || src;
        const alt = typeof mediaItem.alt === 'string' && mediaItem.alt.trim() ? mediaItem.alt : undefined;
        results.push({ type: 'image', mediaId: id, src, fullSrc, mediaType: 'image', alt, ...persistedDims });
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
          case 'event':
            if (hasEvent && !results.some(item => item.type === 'event')) {
              results.push({ type: 'event' });
            }
            break;
          case 'room':
            if (hasRoom && !results.some(item => item.type === 'room')) {
              results.push({ type: 'room' });
            }
            break;
          case 'podcast':
            if (hasPodcast && !results.some(item => item.type === 'podcast')) {
              results.push({ type: 'podcast' });
            }
            break;
          case 'media':
            if (descriptor.id) {
              addMediaItem(descriptor.id, descriptor.mediaType);
            }
            break;
          default:
            break;
        }
      });
    } else {
      if (hasPoll) results.push({ type: 'poll' });
      if (hasArticle) results.push({ type: 'article' });
      if (hasEvent) results.push({ type: 'event' });
      if (hasRoom) results.push({ type: 'room' });
      if (hasPodcast) results.push({ type: 'podcast' });
      results.push(...linkItems);
    }

    mediaArray.forEach((m) => {
      if (!m?.id) return;
      const id = String(m.id);
      if (usedMedia.has(id)) return;
      addMediaItem(id, m.type);
    });

    if (hasEvent && !results.some(item => item.type === 'event')) {
      results.push({ type: 'event' });
    }
    if (hasRoom && !results.some(item => item.type === 'room')) {
      results.push({ type: 'room' });
    }
    if (hasPodcast && !results.some(item => item.type === 'podcast')) {
      results.push({ type: 'podcast' });
    }

    // The descriptor switch above has no `link` case, so a descriptor-driven post
    // never picks its link cards up there — insert them all here (after the last
    // poll/article, else before the first media), keeping their text order.
    if (attachmentDescriptors.length && linkItems.length) {
      let insertIdx = -1;
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].type === 'poll' || results[i].type === 'article') {
          insertIdx = i + 1;
          break;
        }
      }
      if (insertIdx === -1) {
        const firstMediaIdx = results.findIndex(item => item.type === 'image' || item.type === 'video' || item.type === 'gif');
        insertIdx = firstMediaIdx !== -1 ? firstMediaIdx : results.length;
      }
      results.splice(insertIdx, 0, ...linkItems);
    }

    return results;
  }, [attachmentDescriptors, mediaArray, hasPoll, hasArticle, hasEvent, hasRoom, hasPodcast, linkPreviewArray, resolveMediaSrc, oxyServices]);

  type Item =
    | { type: 'nested' }
    | AttachmentItem;

  const items = useMemo(() => {
    const computed: Item[] = [...attachmentItems];
    const shouldIncludeNested = nestedPost && nestingDepth < 2;
    if (shouldIncludeNested) {
      const firstMediaIdx = computed.findIndex(item => item.type === 'image' || item.type === 'video' || item.type === 'gif');
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
    items.filter((item): item is Extract<Item, { type: 'image' | 'video' | 'gif' }> => item.type === 'image' || item.type === 'video' || item.type === 'gif'),
    [items]);

  // Index (within `items`) of the ONE link allowed to render an inline player:
  // the first embeddable link the viewer hasn't disabled for its provider. Every
  // other link — embeddable or not — renders as a static preview card, so a post
  // never shows two players. Recomputed when the items or the per-provider prefs
  // change, so toggling a preference flips the render with no effect/state sync.
  const primaryEmbedIndex = useMemo(
    () => items.findIndex((item) => item.type === 'link' && canEmbed(item.embedParams, item.embedParams ? embedPrefs[item.embedParams.source] : undefined)),
    [items, embedPrefs],
  );

  const hasMultipleMedia = mediaItems.length > 1;
  const hasSingleMedia = mediaItems.length === 1 && !items.some(item => item.type === 'poll' || item.type === 'article' || item.type === 'nested' || item.type === 'link');

  // Open the fullscreen reels viewer seeded at the tapped video. The reels route
  // selects the correct media item via the `mediaIndex` query param, so a post
  // containing several videos (or a video among images) opens at the right one.
  const handleVideoPress = useCallback((mediaId: string) => {
    if (!postId) return;
    const mediaIndex = mediaArray.findIndex(m => String(m?.id) === String(mediaId));
    const query = mediaIndex >= 0 ? `?postId=${postId}&mediaIndex=${mediaIndex}` : `?postId=${postId}`;
    router.push(`/videos${query}`);
  }, [postId, mediaArray, router]);

  // Images-only subset (in render order) powering the zoom gallery. Each entry's
  // position is the index the gallery opens at when its thumbnail is tapped;
  // `imageIndexByMediaId` maps a tapped media id to that position. The gallery
  // renders `fullSrc` (a large variant) so opening fullscreen UPGRADES the image
  // rather than reusing the small in-feed thumbnail (`src`).
  const galleryImages = useMemo<GalleryImage[]>(
    () => mediaItems
      .filter((item): item is Extract<typeof item, { type: 'image' }> => item.type === 'image')
      .map(item => ({ uri: item.fullSrc, alt: item.alt, aspectRatio: readMediaAspectRatio(item) })),
    [mediaItems]
  );

  // Prefetch the lightbox's large variant as soon as the row renders — rows only
  // mount within the feed virtualizer's viewport window, same gating PostItem
  // already relies on to preload author avatars — so tapping a thumbnail opens
  // against a warm image cache instead of a cold fetch.
  useImagePreload(useMemo(() => galleryImages.map(image => image.uri), [galleryImages]));

  const imageIndexByMediaId = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    let index = 0;
    mediaItems.forEach((item) => {
      if (item.type === 'image') {
        map.set(item.mediaId, index);
        index += 1;
      }
    });
    return map;
  }, [mediaItems]);

  const galleryRef = useRef<ZoomableImageGalleryHandle>(null);

  // Registry of thumbnail host nodes keyed by the images-only subset index — the
  // SAME index space the gallery opens/pages/indicator/close use. Populated via
  // callback refs from each image thumbnail (set on mount, cleared on unmount).
  const thumbHostsRef = useRef<Map<number, View>>(new Map());

  // Stable per-index callback refs: the same index always returns the same
  // function identity so the host ref is not detached/reattached every render.
  const registerCallbacksRef = useRef<Map<number, RegisterThumbHost>>(new Map());

  const registerThumbHost = useCallback((index: number): RegisterThumbHost => {
    const cache = registerCallbacksRef.current;
    const existing = cache.get(index);
    if (existing) return existing;
    const callback: RegisterThumbHost = (node: View | null) => {
      if (node) {
        thumbHostsRef.current.set(index, node);
      } else {
        thumbHostsRef.current.delete(index);
      }
    };
    cache.set(index, callback);
    return callback;
  }, []);

  // Measure ANY thumbnail by its images-only subset index for the close
  // fly-back. Resolves null when the host is missing (unmounted/virtualized) so
  // the gallery can fall back to a center fade-out.
  const measureThumb = useCallback<MeasureThumb>((index) => {
    return new Promise<MeasuredRect | null>((resolve) => {
      const node = thumbHostsRef.current.get(index);
      if (!node) {
        resolve(null);
        return;
      }
      node.measureInWindow((x, y, width, height) => {
        if (width > 0 && height > 0) {
          resolve({ x, y, width, height });
        } else {
          resolve(null);
        }
      });
    });
  }, []);

  // Open the zoom gallery seeded at the tapped image's index within the
  // images-only subset, animating from the measured thumbnail rect.
  const handleImagePress = useCallback((mediaId: string, rect?: MeasuredRect) => {
    if (galleryImages.length === 0) return;
    const index = imageIndexByMediaId.get(mediaId) ?? 0;
    galleryRef.current?.open(galleryImages, index, rect);
  }, [galleryImages, imageIndexByMediaId]);

  // Stable per-media press handler keyed by mediaId so PostAttachmentMedia's
  // React.memo can skip a cell when the row re-renders without its media changing.
  // The factory (and its cache) is rebuilt only when the underlying handlers
  // change — i.e. when the media set changes — so handlers never go stale.
  const pressHandlerByMedia = useMemo(() => {
    const cache = new Map<string, (rect?: MeasuredRect) => void>();
    return (mediaId: string, kind: 'video' | 'image'): ((rect?: MeasuredRect) => void) => {
      const existing = cache.get(mediaId);
      if (existing) return existing;
      const handler: (rect?: MeasuredRect) => void =
        kind === 'video'
          ? () => handleVideoPress(mediaId)
          : (rect?: MeasuredRect) => handleImagePress(mediaId, rect);
      cache.set(mediaId, handler);
      return handler;
    };
  }, [handleVideoPress, handleImagePress]);

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
    if (!node || typeof (node as Partial<HTMLElement>).addEventListener !== 'function') return;
    const element = node as unknown as HTMLElement;

    let isDragging = false;
    let startXPos = 0;
    let startScrollLeft = 0;

    const handleMouseDown = (event: MouseEvent) => {
      isDragging = true;
      startXPos = event.pageX;
      startScrollLeft = element.scrollLeft;
      element.style.userSelect = 'none';
    };

    const stopDragging = () => {
      if (!isDragging) return;
      isDragging = false;
      element.style.removeProperty('user-select');
    };

    const handleMouseMove = (event: MouseEvent) => {
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
      element.style.removeProperty('user-select');
    };
  }, [items.length]);

  if (items.length === 0) return null;

  const scrollerPaddingRight = 12;
  const scrollerPaddingLeft = Math.abs(leftOffset);
  const nestedWidth = scrollViewWidth - scrollerPaddingLeft - scrollerPaddingRight;

  return (
    <>
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
      style={style}
      contentContainerStyle={[styles.scroller, leftOffset ? { paddingLeft: leftOffset } : null]}
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
        if (item.type === 'event') {
          return (
            <PostAttachmentEvent
              key={`event-${idx}`}
              name={event?.name || ''}
              date={event?.date || ''}
              location={event?.location}
              onPress={onEventPress || undefined}
            />
          );
        }
        if (item.type === 'room') {
          return (
            <PostAttachmentRoom
              key={`room-${idx}`}
              roomId={room?.roomId || ''}
              title={room?.title || ''}
              status={room?.status}
              topic={room?.topic}
              host={room?.host}
              onPress={onRoomPress || undefined}
            />
          );
        }
        if (item.type === 'podcast') {
          if (!podcast) return null;
          return (
            <PodcastCard
              key={`podcast-${idx}`}
              variant="card"
              title={podcast.title}
              author={podcast.author}
              artworkUrl={podcast.artworkUrl}
              showUrl={podcast.showUrl}
            />
          );
        }
        if (item.type === 'link') {
          // Only the first embeddable link (and not one the viewer hid for that
          // provider) becomes the inline external player — the post's primary
          // media. Every other link stays a static preview card.
          if (idx === primaryEmbedIndex) {
            return (
              <PostAttachmentExternalEmbed
                key={`embed-${idx}`}
                url={item.url}
                title={item.title}
                description={item.description}
                image={item.image}
                siteName={item.siteName}
                width={nestedWidth}
              />
            );
          }
          return (
            <PostAttachmentLink
              key={`link-${idx}`}
              url={item.url}
              title={item.title}
              description={item.description}
              image={item.image}
              siteName={item.siteName}
              constrainedHeight={items.length > 1 ? MEDIA_CARD_HEIGHT : undefined}
            />
          );
        }
        if (item.type === 'poll') {
          return (
            <PostAttachmentPoll
              key={`poll-${idx}`}
              pollId={pollId}
              pollData={pollData ?? undefined}
            />
          );
        }
        if (item.type === 'nested') {
          if (!nestedPost) return null;
          return (
            <PostAttachmentNested
              key={`nested-${idx}`}
              nestedPost={nestedPost}
              nestingDepth={nestingDepth}
              width={nestedWidth}
            />
          );
        }
        if (item.type === 'gif') {
          // Native gif = inline looping muted video; no reels routing, no lightbox.
          return (
            <PostAttachmentMedia
              key={`gif-${item.mediaId ?? idx}`}
              type="gif"
              src={item.src}
              mediaId={item.mediaId}
              postId={postId}
              width={item.width}
              height={item.height}
              aspectRatio={item.aspectRatio}
              hasSingleMedia={hasSingleMedia}
              hasMultipleMedia={hasMultipleMedia}
              sensitive={sensitive}
            />
          );
        }
        if (item.type === 'video' || item.type === 'image') {
          const mediaId = item.mediaId;
          // Images register their host node at their images-only subset index so
          // the gallery's close fly-back can target the currently-viewed thumb.
          const imageIndex = item.type === 'image' ? imageIndexByMediaId.get(mediaId) : undefined;
          return (
            <PostAttachmentMedia
              key={`${item.type}-${mediaId ?? idx}`}
              type={item.type}
              src={item.src}
              alt={item.type === 'image' ? item.alt : undefined}
              mediaId={mediaId}
              poster={item.type === 'video' ? item.poster : undefined}
              width={item.width}
              height={item.height}
              aspectRatio={item.aspectRatio}
              durationSec={item.type === 'video' ? item.durationSec : undefined}
              postId={postId}
              onPress={pressHandlerByMedia(mediaId, item.type)}
              registerHost={imageIndex !== undefined ? registerThumbHost(imageIndex) : undefined}
              hasSingleMedia={hasSingleMedia}
              hasMultipleMedia={hasMultipleMedia}
              sensitive={sensitive}
            />
          );
        }
        return null;
      })}
    </ScrollView>
    {galleryImages.length > 0 && <ZoomableImageGallery ref={galleryRef} measureThumb={measureThumb} cornerRadius={MEDIA_CARD_RADIUS} />}
    </>
  );
}, (prevProps, nextProps) => {
  if (!areLinkPreviewsEqual(prevProps.linkPreviews, nextProps.linkPreviews)) return false;
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
    prevProps.event === nextProps.event &&
    prevProps.onEventPress === nextProps.onEventPress &&
    prevProps.room === nextProps.room &&
    prevProps.onRoomPress === nextProps.onRoomPress &&
    prevProps.podcast === nextProps.podcast &&
    prevProps.text === nextProps.text &&
    prevProps.location === nextProps.location &&
    prevProps.sources === nextProps.sources &&
    prevProps.onSourcesPress === nextProps.onSourcesPress &&
    prevProps.sensitive === nextProps.sensitive
  );
});

PostAttachmentsRow.displayName = 'PostAttachmentsRow';

const styles = StyleSheet.create({
  scroller: {
    paddingRight: 12,
    gap: 12,
  },
});

export default PostAttachmentsRow;
