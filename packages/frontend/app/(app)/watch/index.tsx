import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { PageHeader } from '@oxy.so/bloom/page-header';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { SEO } from '@/components/SEO';
import { ClipsIcon } from '@/components/videos/ClipsIcon';
import {
  VideoPreviewCard,
  VideoPreviewGrid,
  VideoPreviewSkeleton,
} from '@/components/videos/VideoPreviewCard';
import { portraitVideo, watchVideo } from '@/components/videos/watchVideo';
import { useRouter } from '@/lib/navigation/router';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { feedService } from '@/services/feedService';

const WATCH_INSET = 16;

type WatchFilter = 'all' | 'videos' | 'clips';

const FILTER_KEYS = {
  all: 'videos.browseAll',
  videos: 'sidebar.videos',
  clips: 'videos.clips',
} as const;

export default function WatchHomeRoute() {
  const { t, i18n } = useTranslation();
  const { user, oxyServices, isAuthResolved } = useAuth();
  const router = useRouter();
  const locale = i18n.resolvedLanguage || i18n.language;
  const [filter, setFilter] = useState<WatchFilter>('all');
  const [columns, setColumns] = useState(1);
  const videos = useInfiniteQuery({
    queryKey: viewerQueryKeys.watchCatalog(user?.id, locale),
    queryFn: ({ pageParam, signal }) =>
      feedService.getMtnFeed('videos', {
        cursor: pageParam,
        limit: 24,
        orientation: 'landscape',
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: ({ hasMore, nextCursor }, _pages, _currentCursor, cursors) =>
      hasMore && nextCursor && !cursors.includes(nextCursor) ? nextCursor : undefined,
    enabled: isAuthResolved && filter !== 'clips',
    staleTime: 60_000,
  });
  const clips = useQuery({
    queryKey: viewerQueryKeys.watchClips(user?.id, locale),
    queryFn: ({ signal }) => feedService.getMtnFeed('videos', { limit: 32, signal }),
    enabled: isAuthResolved && filter !== 'videos',
    staleTime: 60_000,
  });
  const canLoadMore =
    filter !== 'clips' && videos.hasNextPage && !videos.isFetching && !videos.isError;
  const loadMore = () => void videos.fetchNextPage({ cancelRefetch: false });
  const loadingVideos = videos.isPending || videos.isFetchingNextPage;
  const openClips = () => router.push('/videos');

  const seen = new Set<string>();
  const cards = (videos.data?.pages ?? []).flatMap((page) =>
    page.items.flatMap((post) => {
      if (seen.has(post.id)) return [];
      seen.add(post.id);
      const video = watchVideo(post, oxyServices);
      return video ? [<VideoPreviewCard key={post.id} video={video} locale={locale} t={t} />] : [];
    }),
  );

  const clipPreviews = (clips.data?.items ?? [])
    .flatMap((post) => portraitVideo(post, oxyServices) ?? [])
    .slice(0, 8);
  const hasShelf = clipPreviews.length > 0 && filter !== 'videos';
  const featuredCount = filter === 'all' && hasShelf ? columns : 0;

  return (
    <Screen
      scroll="auto"
      testID="watch-home-screen"
      header={
        <PageHeader
          title={t('sidebar.videos')}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          actions={
            <Button size="sm" onPress={() => router.push('/video-upload')}>
              {t('videos.upload')}
            </Button>
          }
        />
      }
    >
      <SEO title={t('videos.browse')} robots="index,follow" />
      <ScreenScrollView
        onEndReached={canLoadMore ? loadMore : undefined}
        onEndReachedThreshold={0.6}
      >
        <View
          className="min-w-0 gap-4 pb-8 pt-3"
          onLayout={({
            nativeEvent: {
              layout: { width },
            },
          }) => {
            const available = width - WATCH_INSET * 2;
            setColumns(available >= 1120 ? 4 : available >= 720 ? 3 : available >= 460 ? 2 : 1);
          }}
        >
          <ChipRow contentInset={WATCH_INSET} accessibilityLabel={t('search.filters.label')}>
            {(Object.keys(FILTER_KEYS) as WatchFilter[]).map((option) => (
              <Chip
                key={option}
                variant="subtle"
                selected={filter === option}
                onPress={() => setFilter(option)}
              >
                {t(FILTER_KEYS[option])}
              </Chip>
            ))}
          </ChipRow>
          {featuredCount > 0 && (
            <View style={styles.gridInset}>
              <VideoPreviewGrid cards={cards.slice(0, featuredCount)} columns={columns} />
            </View>
          )}
          {hasShelf ? (
            <View className="gap-2" testID="watch-clips">
              <View className="flex-row items-center justify-between gap-3" style={styles.inset}>
                <View className="flex-row items-center gap-2">
                  <ClipsIcon size="lg" className="text-primary" />
                  <Text accessibilityRole="header" className="text-lg font-bold text-foreground">
                    {t('videos.clips')}
                  </Text>
                </View>
                <Button size="sm" appearance="subtle" onPress={openClips}>
                  {t('videos.openClips')}
                </Button>
              </View>
              <ScrollView
                testID="watch-clips-track"
                horizontal
                accessibilityLabel={t('videos.clips')}
                className="w-full min-w-0"
                contentContainerStyle={styles.clipTrack}
              >
                {clipPreviews.map((video) => (
                  <View key={video.post.id} className="w-[138px] sm:w-[164px]">
                    <VideoPreviewCard video={video} clip locale={locale} t={t} />
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : filter === 'clips' && clips.isPending ? (
            <Skeleton.Region
              testID="watch-clips-skeleton"
              className="flex-row overflow-hidden"
              style={styles.clipTrack}
            >
              {[0, 1, 2, 3].map((key) => (
                <View key={key} className="w-[138px] sm:w-[164px]">
                  <VideoPreviewSkeleton clip />
                </View>
              ))}
            </Skeleton.Region>
          ) : filter === 'clips' ? (
            <View className="items-start gap-3" style={styles.inset}>
              <Text className="text-muted-foreground">
                {t(clips.isError ? 'videos.load_failed' : 'videos.no_video_posts_yet')}
              </Text>
              <Button
                size="sm"
                appearance="outline"
                onPress={clips.isError ? () => void clips.refetch() : openClips}
              >
                {t(clips.isError ? 'common.retry' : 'videos.openClips')}
              </Button>
            </View>
          ) : null}
          {filter !== 'clips' && (
            <View className="gap-4" style={styles.gridInset}>
              {cards.length > featuredCount && (
                <VideoPreviewGrid cards={cards.slice(featuredCount)} columns={columns} />
              )}
              {loadingVideos ? (
                <Skeleton.Region testID="watch-catalog-skeleton">
                  <VideoPreviewGrid
                    columns={columns}
                    cards={Array.from(
                      { length: columns * (videos.isFetchingNextPage ? 1 : 2) },
                      (_, key) => <VideoPreviewSkeleton key={key} />,
                    )}
                  />
                </Skeleton.Region>
              ) : (
                cards.length === 0 && (
                  <Text className="py-2 text-muted-foreground">
                    {t(videos.isError ? 'videos.load_failed' : 'videos.no_video_posts_yet')}
                  </Text>
                )
              )}
              {videos.isError && (
                <View className="items-center">
                  <Button
                    size="sm"
                    appearance="outline"
                    disabled={videos.isFetching}
                    onPress={videos.isFetchNextPageError ? loadMore : () => void videos.refetch()}
                  >
                    {t('common.retry')}
                  </Button>
                </View>
              )}
            </View>
          )}
        </View>
      </ScreenScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: WATCH_INSET },
  gridInset: { paddingHorizontal: WATCH_INSET - 4 },
  clipTrack: { gap: 4, paddingHorizontal: WATCH_INSET - 3 },
});
