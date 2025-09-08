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
  const { fetchUserFeed, postsById } = usePostsStore();
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
    const globalSeen = new Set<string>(); // avoid duplicate URIs across posts
    // Prefer dedicated media feed if available; fallback to posts feed
    const items = (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])) as any[];
    const pickIdOrUrl = (x: any): string | undefined => {
      if (!x) return undefined;
      if (typeof x === 'string') return x;
      return x.id || x.url || x.src || x.path || undefined;
    };
    const extractFrom = (post: any, targetId: string) => {
      const collected: string[] = [];
      const pushFromArray = (arr?: any[]) => {
        if (!Array.isArray(arr) || !arr.length) return;
        arr.forEach((m) => {
          const raw = pickIdOrUrl(m);
          if (raw) collected.push(raw);
        });
      };
      pushFromArray(post?.content?.media);
      pushFromArray(post?.content?.images);
      pushFromArray(post?.content?.attachments);
      pushFromArray(post?.content?.files);
      pushFromArray(post?.media); // legacy

      // Deduplicate while preserving order
      const seen = new Set<string>();
      collected.forEach((raw, idx) => {
        const uri = resolveImageUri(raw);
        if (!uri || seen.has(uri) || globalSeen.has(uri)) return;
        seen.add(uri);
        globalSeen.add(uri);
        const isVideo = /\.(mp4|mov|m4v|webm)$/i.test(String(raw));
        const isCarousel = collected.length > 1;
        out.push({ postId: targetId, uri, isVideo, isCarousel, mediaIndex: idx });
      });
    };

    for (const p of items as any[]) {
      extractFrom(p, String(p.id));
      // If wrapper has no media, try original/quoted post in cache
      const origId = p?.originalPostId || p?.repostOf || p?.quoteOf;
      if (origId && (!p?.content?.media?.length && !p?.content?.images?.length && !p?.media?.length)) {
        const orig = postsById?.[String(origId)];
        if (orig) extractFrom(orig, String(p.id));
      }
    }
    return out.filter(Boolean) as { postId: string; uri: string; isVideo: boolean; isCarousel: boolean; mediaIndex: number }[];
  }, [mediaFeed?.items, postsFeed?.items, resolveImageUri, postsById]);

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
