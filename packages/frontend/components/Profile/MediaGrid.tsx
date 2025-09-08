import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { colors } from '@/styles/colors';
import { usePostsStore, useUserFeedSelector } from '@/stores/postsStore';

interface MediaGridProps {
  userId?: string;
}

const NUM_COLUMNS = 3;
const GAP = 1; // instagram-like tight spacing
const H_PADDING = 0;

const MediaGrid: React.FC<MediaGridProps> = ({ userId }) => {
  const { oxyServices } = useOxy();
  const router = useRouter();
  const { fetchUserFeed } = usePostsStore();
  const mediaFeed = useUserFeedSelector(userId || '', 'media');
  const postsFeed = useUserFeedSelector(userId || '', 'posts');
  // Non-scrollable grid inside parent ScrollView; pull-to-refresh handled by parent
  const [containerWidth, setContainerWidth] = useState<number>(Dimensions.get('window').width);
  const itemSize = useMemo(() => {
    const totalGap = GAP * (NUM_COLUMNS - 1) + H_PADDING * 2;
    return Math.floor((containerWidth - totalGap) / NUM_COLUMNS);
  }, [containerWidth]);

  useEffect(() => {
    const load = async () => {
      if (!userId) return;
      await fetchUserFeed(userId, { type: 'media', limit: 30 });
    };
    load();
    return () => {};
  }, [userId, fetchUserFeed]);

  // Fallback: if media feed finished and is empty, attempt to load posts feed for media extraction
  useEffect(() => {
    const maybeFallback = async () => {
      if (!userId) return;
      const isLoaded = !!mediaFeed && !mediaFeed.isLoading;
      const isEmpty = (mediaFeed?.items?.length || 0) === 0;
      const postsLoaded = !!postsFeed;
      if (isLoaded && isEmpty && !postsLoaded) {
        await fetchUserFeed(userId, { type: 'posts', limit: 60 });
      }
    };
    maybeFallback();
  }, [userId, mediaFeed, mediaFeed?.isLoading, mediaFeed?.items?.length, postsFeed, fetchUserFeed]);

  const resolveImageUri = useCallback(
    (path?: string): string | undefined => {
      if (!path) return undefined;
      if (/^https?:\/\//i.test(path)) return path;
      try {
        // Fallback to Oxy file download if path is an asset key
        return (oxyServices as any)?.getFileDownloadUrl?.(path, 'thumb') ?? path;
      } catch {
        return path;
      }
    },
    [oxyServices]
  );

  const mediaItems = useMemo(() => {
    const out: ({ postId: string; uri: string; isVideo: boolean; isCarousel: boolean; mediaIndex: number } | null)[] = [];
    // Prefer dedicated media feed if available; fallback to posts feed
    const items = (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])) as any[];
    for (const p of items as any[]) {
      // Prefer modern content.media (array of objects or strings)
      const mediaArr = (p?.content?.media as any[]) || [];
      if (Array.isArray(mediaArr) && mediaArr.length) {
        const uniq = new Set<string>();
        const isCarousel = mediaArr.length > 1;
        mediaArr.forEach((m: any, idx: number) => {
          const raw = typeof m === 'string' ? m : (m?.id || m?.url);
          if (!raw) return;
          const uri = resolveImageUri(raw);
          if (!uri || uniq.has(uri)) return;
          uniq.add(uri);
          const type = typeof m === 'string' ? undefined : m?.type;
          const isVideo = type === 'video' || /\.(mp4|mov|m4v|webm)$/i.test(String(raw));
          out.push({ postId: String(p.id), uri, isVideo, isCarousel, mediaIndex: idx });
        });
        continue; // prefer content.media when present
      }

      // Fallbacks: legacy content.images or root-level media string array
      const imgs: string[] = (p?.content?.images as string[]) || (p?.media as string[]) || [];
      if (imgs?.length) {
        const uniq = new Set<string>();
        const isCarousel = imgs.length > 1;
        imgs.forEach((raw: string, idx: number) => {
          const uri = resolveImageUri(raw);
          if (!uri || uniq.has(uri)) return;
          uniq.add(uri);
          const isVideo = /\.(mp4|mov|m4v|webm)$/i.test(String(raw));
          out.push({ postId: String(p.id), uri, isVideo, isCarousel, mediaIndex: idx });
        });
      }
    }
    return out.filter(Boolean) as { postId: string; uri: string; isVideo: boolean; isCarousel: boolean; mediaIndex: number }[];
  }, [mediaFeed?.items, postsFeed?.items, resolveImageUri]);

  // Refresh handled outside by parent feed/scroll

  // Note: Grid is rendered inside ProfileScreen's outer ScrollView; keep FlatList non-scrollable

  const renderItem = useCallback(({ item }: { item: { postId: string; uri: string; isVideo: boolean; isCarousel: boolean; mediaIndex: number } }) => (
    <TouchableOpacity
      activeOpacity={0.8}
      style={{ width: itemSize, height: itemSize, backgroundColor: colors.COLOR_BLACK_LIGHT_8 }}
      onPress={() => router.push(`/p/${item.postId}`)}
    >
      <Image
        source={{ uri: item.uri }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="cover"
      />
      {(item.isVideo || item.isCarousel) && (
        <View style={styles.badges}>
          {item.isCarousel ? (
            <Ionicons name="images-outline" size={16} color="#fff" />
          ) : null}
          {item.isVideo ? (
            <Ionicons name="film-outline" size={16} color="#fff" style={{ marginLeft: 6 }} />
          ) : null}
        </View>
      )}
    </TouchableOpacity>
  ), [itemSize, router]);

  const keyExtractor = useCallback((it: { postId: string; uri: string; mediaIndex?: number }, index: number) => `${it.postId}:${it.mediaIndex ?? index}`, []);

  const getItemLayout = useCallback((_: any, index: number) => {
    const size = itemSize;
    const row = Math.floor(index / NUM_COLUMNS);
    const length = size;
    const offset = row * (size + GAP) + 8; // +8 for top padding in contentContainerStyle
    return { length, offset, index };
  }, [itemSize]);

  // Loading state first; if no items yet and feeds are still loading, show spinner
  const isLoading = (!mediaFeed && !postsFeed) || mediaFeed?.isLoading || postsFeed?.isLoading;
  if (isLoading && mediaItems.length === 0) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primaryColor} />
      </View>
    );
  }

  if (!isLoading && mediaItems.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No media posts yet</Text>
        <Text style={styles.emptySub}>Photos and videos you share will appear here.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      <FlatList
        data={mediaItems}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        numColumns={NUM_COLUMNS}
        columnWrapperStyle={{ gap: GAP }}
        contentContainerStyle={{ gap: GAP, paddingHorizontal: H_PADDING, paddingTop: 8, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        scrollEnabled={false}
        removeClippedSubviews
        initialNumToRender={18}
        windowSize={7}
        getItemLayout={getItemLayout}
      />
    </View>
  );
};

export default MediaGrid;

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.primaryLight,
  },
  loading: {
    paddingVertical: 24,
  },
  badges: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.COLOR_BLACK_LIGHT_2,
  },
  emptySub: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
});
