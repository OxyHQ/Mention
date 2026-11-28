import { useEffect } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useDeckSettings } from '@/components/deck/deckSettings';
import { WatchVideoSkeleton } from '@/components/loading/ContentSkeleton';
import { VideoRecommendations } from '@/components/videos/VideoSuggestions';
import { WatchPlayerSurface } from '@/components/videos/WatchPlayerSurface';
import { WatchVideoDetails, usePublishWatchDetails } from '@/components/videos/WatchVideoDetails';
import { watchVideo } from '@/components/videos/watchVideo';
import {
  concealVideo,
  revealVideo,
  useRevealedVideos,
  videoContentWarning,
} from '@/components/videos/videoWarning';
import { usePostReadAccess } from '@/hooks/usePostReadAccess';
import { useIsFocused, useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import { useOptionalPanelRouter } from '@oxy.so/bloom/panel-routing';
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
  // The details rail exists only in the standard shell: Deck hides it, and a
  // Deck column never has one.
  const inDeckColumn = Boolean(useOptionalPanelRouter());
  const deckEnabled = useDeckSettings((state) => state.deckEnabled);
  const deckAvailable = useDeckAvailable();
  const hasSidebar = width >= 990 && !inDeckColumn && !(deckEnabled && deckAvailable);
  const postRead = useQuery({
    queryKey: viewerQueryKeys.watchVideo(user?.id, id, i18n.resolvedLanguage),
    enabled: isAuthResolved && access.allowed && Boolean(id),
    queryFn: () => getPostById(id),
  });
  const post = access.allowed ? postRead.data : undefined;
  const requestedIndex = mediaIndex && /^\d+$/.test(mediaIndex) ? Number(mediaIndex) : undefined;
  const video = post ? watchVideo(post, oxyServices, requestedIndex) : null;
  usePublishWatchDetails(video ? post : undefined, hasSidebar && focused);
  const revealed = useRevealedVideos((state) => state.ids.has(id ?? ''));
  // Consent lasts as long as this page, for this viewer.
  useEffect(() => () => concealVideo(id ?? ''), [id, user?.id]);
  const warning = videoContentWarning(post);
  const pending = Boolean(id) && !access.failed && (!access.allowed || postRead.isPending);
  const concealed = Boolean(post && (post.metadata.isSensitive || warning) && !revealed);

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
                <View className="h-full w-full items-center justify-center gap-3 px-6">
                  {warning ? (
                    <Text className="text-center text-sm font-semibold text-white">{warning}</Text>
                  ) : null}
                  <Button onPress={() => revealVideo(post.id)}>
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
