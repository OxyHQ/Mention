import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { SEO } from '@/components/SEO';
import { VideoPreviewCard, VideoPreviewGrid } from '@/components/videos/VideoPreviewCard';
import { portraitVideo, watchVideo } from '@/components/videos/watchVideo';
import { useRouter } from '@/lib/navigation/router';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { feedService } from '@/services/feedService';

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
    getNextPageParam: (page) => (page.hasMore ? page.nextCursor : undefined),
    enabled: isAuthResolved && filter !== 'clips',
    staleTime: 60_000,
  });
  const clips = useQuery({
    queryKey: viewerQueryKeys.watchClips(user?.id, locale),
    queryFn: ({ signal }) => feedService.getMtnFeed('videos', { limit: 32, signal }),
    enabled: isAuthResolved && filter !== 'videos',
    staleTime: 60_000,
  });
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
      scroll="content"
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
      <ScreenScrollView contentContainerClassName="px-3 pb-8 pt-3 sm:px-5">
        <View
          className="gap-6"
          onLayout={({
            nativeEvent: {
              layout: { width },
            },
          }) => {
            setColumns(width >= 1120 ? 4 : width >= 720 ? 3 : width >= 460 ? 2 : 1);
          }}
        >
          <View className="flex-row flex-wrap gap-2">
            {(Object.keys(FILTER_KEYS) as WatchFilter[]).map((option) => (
              <Button
                key={option}
                size="sm"
                tone={filter === option ? 'accent' : 'neutral'}
                appearance={filter === option ? 'solid' : 'subtle'}
                accessibilityState={{ selected: filter === option }}
                onPress={() => setFilter(option)}
              >
                {t(FILTER_KEYS[option])}
              </Button>
            ))}
          </View>
          {featuredCount > 0 && (
            <VideoPreviewGrid cards={cards.slice(0, featuredCount)} columns={columns} />
          )}
          {hasShelf ? (
            <View className="gap-3" testID="watch-clips">
              <View className="flex-row items-center justify-between gap-3">
                <View className="flex-row items-center gap-2">
                  <RiPlayFill size="lg" className="text-primary" />
                  <Text accessibilityRole="header" className="text-lg font-bold text-foreground">
                    {t('videos.clips')}
                  </Text>
                </View>
                <Button size="sm" appearance="subtle" onPress={openClips}>
                  {t('videos.openClips')}
                </Button>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12 }}
              >
                {clipPreviews.map((video) => (
                  <View key={video.post.id} className="w-[138px] sm:w-[164px]">
                    <VideoPreviewCard video={video} clip locale={locale} t={t} />
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : filter === 'clips' ? (
            <View className="items-start gap-3">
              <Text className="text-muted-foreground">
                {t(
                  clips.isPending
                    ? 'common.loading'
                    : clips.isError
                      ? 'videos.load_failed'
                      : 'videos.no_video_posts_yet',
                )}
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
            <>
              {cards.length ? (
                <VideoPreviewGrid cards={cards.slice(featuredCount)} columns={columns} />
              ) : (
                <Text className="py-2 text-muted-foreground">
                  {t(
                    videos.isPending
                      ? 'common.loading'
                      : videos.isError
                        ? 'videos.load_failed'
                        : 'videos.no_video_posts_yet',
                  )}
                </Text>
              )}
              {videos.hasNextPage || videos.isError ? (
                <View className="items-center">
                  <Button
                    size="sm"
                    appearance="outline"
                    disabled={videos.isFetching}
                    onPress={() =>
                      void (videos.hasNextPage ? videos.fetchNextPage() : videos.refetch())
                    }
                  >
                    {t(
                      videos.isFetchingNextPage
                        ? 'common.loading'
                        : videos.isError
                          ? 'common.retry'
                          : 'common.loadMore',
                    )}
                  </Button>
                </View>
              ) : null}
            </>
          )}
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
