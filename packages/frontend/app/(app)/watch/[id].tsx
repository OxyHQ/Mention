import { useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import VideoPlayer from '@/components/common/VideoPlayer';
import { VideoRecommendations } from '@/components/videos/VideoSuggestions';
import { WatchVideoDetails, usePublishWatchDetails } from '@/components/videos/WatchVideoDetails';
import { watchVideo } from '@/components/videos/watchVideo';
import { usePostReadAccess } from '@/hooks/usePostReadAccess';
import { useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import { usePostsStore } from '@/stores/postsStore';

export default function WatchRoute() {
  const { id, mediaIndex } = useLocalSearchParams<{ id: string; mediaIndex?: string }>();
  const { t, i18n } = useTranslation();
  const { user, oxyServices, isAuthResolved } = useAuth();
  const router = useRouter();
  const access = usePostReadAccess(id ?? '');
  const getPostById = usePostsStore((state) => state.getPostById);
  const width = useWindowDimensions().width;
  const hasSidebar = width >= 990;
  const postRead = useQuery({
    queryKey: ['watch-post', user?.id, i18n.resolvedLanguage, id],
    enabled: isAuthResolved && access.allowed && Boolean(id),
    queryFn: () => getPostById(id),
  });
  const post = access.allowed ? postRead.data : undefined;
  const requestedIndex = mediaIndex && /^\d+$/.test(mediaIndex) ? Number(mediaIndex) : undefined;
  const video = post ? watchVideo(post, oxyServices, requestedIndex) : null;
  usePublishWatchDetails(video ? post : undefined, hasSidebar);
  const [revealed, setRevealed] = useState<string>();
  const videoKey = `${id}:${mediaIndex ?? ''}`;

  return (
    <Screen
      scroll="auto"
      testID="watch-video-screen"
      header={
        <PageHeader
          title={t('videos.reel', { defaultValue: 'Video' })}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/videos'))}
        />
      }
    >
      {video && post ? (
        <View className="gap-4 px-3 pb-8 pt-2">
          <View className="min-w-0 flex-1 gap-4">
            <View className="aspect-video w-full items-center justify-center overflow-hidden rounded-2xl bg-black">
              {post.metadata.isSensitive && revealed !== videoKey ? (
                <Button onPress={() => setRevealed(videoKey)}>
                  {t('post.sensitiveContentTap')}
                </Button>
              ) : (
                <VideoPlayer
                  key={videoKey}
                  src={video.source}
                  fallbackSrc={video.fallbackSource}
                  poster={video.poster}
                  contentFit="contain"
                  controlsLayout="watch"
                  autoPlay
                  style={{ width: '100%', height: '100%' }}
                />
              )}
            </View>
          </View>
          {hasSidebar ? null : <WatchVideoDetails key={post.id} post={post} />}
          <VideoRecommendations current={post} columns={width >= 600 ? 3 : 2} />
        </View>
      ) : (
        <Text className="p-5 text-muted-foreground">
          {!access.failed && (!access.allowed || postRead.isPending)
            ? t('common.loading')
            : t('videos.unavailable')}
        </Text>
      )}
    </Screen>
  );
}
