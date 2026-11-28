import { useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { WatchVideoSkeleton } from '@/components/loading/ContentSkeleton';
import { VideoRecommendations } from '@/components/videos/VideoSuggestions';
import { WatchPlayerSurface } from '@/components/videos/WatchPlayerSurface';
import { WatchVideoDetails, usePublishWatchDetails } from '@/components/videos/WatchVideoDetails';
import { watchVideo } from '@/components/videos/watchVideo';
import { usePostReadAccess } from '@/hooks/usePostReadAccess';
import { useIsFocused, useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { usePostsStore } from '@/stores/postsStore';

export default function WatchRoute() {
  const { id, mediaIndex } = useLocalSearchParams<{ id: string; mediaIndex?: string }>();
  const { t, i18n } = useTranslation();
  const { user, oxyServices, isAuthResolved } = useAuth();
  const router = useRouter();
  const focused = useIsFocused();
  const access = usePostReadAccess(id ?? '');
  const getPostById = usePostsStore((state) => state.getPostById);
  const width = useWindowDimensions().width;
  const hasSidebar = width >= 990;
  const postRead = useQuery({
    queryKey: viewerQueryKeys.watchVideo(user?.id, id, i18n.resolvedLanguage),
    enabled: isAuthResolved && access.allowed && Boolean(id),
    queryFn: () => getPostById(id),
  });
  const post = access.allowed ? postRead.data : undefined;
  const requestedIndex = mediaIndex && /^\d+$/.test(mediaIndex) ? Number(mediaIndex) : undefined;
  const video = post ? watchVideo(post, oxyServices, requestedIndex) : null;
  usePublishWatchDetails(video ? post : undefined, hasSidebar && focused);
  const [revealed, setRevealed] = useState<string>();
  const pending = Boolean(id) && !access.failed && (!access.allowed || postRead.isPending);
  const videoKey = `${id}:${mediaIndex ?? ''}`;
  const concealed = Boolean(post?.metadata.isSensitive && revealed !== videoKey);

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
            <WatchPlayerSurface
              video={video}
              focused={focused}
              dockable={hasSidebar}
              concealed={concealed}
              canContinue={
                !access.supervised &&
                !post.metadata.isSensitive &&
                !post.metadata.spoilerText &&
                !post.metadata.recipients?.length &&
                !('visibility' in post.metadata && post.metadata.visibility !== 'public')
              }
            >
              {concealed ? (
                <View className="h-full w-full items-center justify-center">
                  <Button onPress={() => setRevealed(videoKey)}>
                    {t('post.sensitiveContentTap')}
                  </Button>
                </View>
              ) : null}
            </WatchPlayerSurface>
          </View>
          {hasSidebar ? null : <WatchVideoDetails key={post.id} post={post} />}
          <VideoRecommendations current={post} columns={width >= 600 ? 3 : 2} />
        </View>
      ) : pending ? (
        <WatchVideoSkeleton showDetails={!hasSidebar} />
      ) : (
        <Text className="p-5 text-muted-foreground">{t('videos.unavailable')}</Text>
      )}
    </Screen>
  );
}
