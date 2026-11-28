import { useEffect } from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { create } from 'zustand';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import { Button } from '@oxy.so/bloom/button';
import { formatDuration } from '@/utils/formatDuration';
import { Link } from '@/lib/navigation/router';
import { feedService } from '@/services/feedService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { watchVideo, type WatchPost } from './watchVideo';
import { videoPublicationDate, videoViewCount } from './videoMetadata';

const useActiveVideo = create<{ post?: WatchPost }>(() => ({}));

export function usePublishVideoSuggestions(post: WatchPost | null | undefined, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !post) return;
    useActiveVideo.setState({ post });
    return () => {
      if (useActiveVideo.getState().post === post) useActiveVideo.setState({ post: undefined });
    };
  }, [post, enabled]);
}

function readHashtags(post?: WatchPost) {
  return (post?.content.text ?? '').toLowerCase().match(/#[\p{L}\p{N}_]+/gu) ?? [];
}

export function VideoSuggestions() {
  const post = useActiveVideo((state) => state.post);
  return (
    <ScrollView testID="video-suggestions" className="max-h-[100dvh]">
      <VideoRecommendations current={post} />
    </ScrollView>
  );
}

export function VideoRecommendations({
  current,
  columns,
}: {
  current?: WatchPost;
  columns?: 2 | 3;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const { oxyServices, user, isAuthResolved } = useAuth();
  const feed = useQuery({
    queryKey: viewerQueryKeys.videoSuggestions(user?.id, i18n.resolvedLanguage),
    enabled: isAuthResolved,
    queryFn: ({ signal }) =>
      feedService.getMtnFeed('videos', { limit: 16, orientation: 'landscape', signal }),
    staleTime: 60_000,
  });
  const activeTags = new Set(readHashtags(current));
  const suggestions = (feed.data?.items ?? [])
    .flatMap((post) => {
      if (post.id === current?.id) return [];
      const video = watchVideo(post, oxyServices);
      if (!video) return [];
      const relatedness =
        Number(Boolean(current?.user.id) && post.user.id === current?.user.id) +
        Number(readHashtags(post).some((tag) => activeTags.has(tag)));
      return [{ ...video, relatedness }];
    })
    .sort((a, b) => b.relatedness - a.relatedness);

  const cards = suggestions.map(({ post, mediaIndex, poster, duration }) => {
    const handle = getNormalizedUserHandle(post.user);
    const author = post.user.name?.displayName || (handle ? `@${handle}` : '');
    const title =
      post.content.title?.trim() ||
      post.content.text?.trim() ||
      author ||
      t('videos.reel', { defaultValue: 'Video' });
    const metadata = columns
      ? [
          videoViewCount(t, locale, post.engagement.views, true),
          videoPublicationDate(post.metadata.createdAt, locale).relative,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    return (
      <Link
        key={post.id}
        href={{
          pathname: '/watch/[id]',
          params: { id: post.id, mediaIndex: String(mediaIndex) },
        }}
        asChild
      >
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={author && author !== title ? `${title}, ${author}` : title}
          className={
            columns
              ? 'min-w-0 flex-1 gap-2 rounded-xl pb-2 hover:bg-muted focus-visible:bg-muted'
              : 'flex-row items-start gap-3 rounded-xl p-2 hover:bg-muted focus-visible:bg-muted'
          }
        >
          <View
            className={`aspect-video ${columns ? 'w-full' : 'w-[124px]'} items-center justify-center overflow-hidden rounded-lg bg-muted`}
          >
            {poster && !post.metadata.isSensitive ? (
              <Image source={poster} contentFit="cover" style={{ width: '100%', height: '100%' }} />
            ) : (
              <RiVideoLine size="md" color="currentColor" />
            )}
            {duration !== undefined && (
              <Text className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-xs font-semibold text-white">
                {formatDuration(duration)}
              </Text>
            )}
          </View>
          <View className={columns ? 'min-w-0 gap-1 px-1' : 'min-w-0 flex-1 gap-1'}>
            <Text numberOfLines={2} className="text-sm font-semibold text-foreground">
              {title}
            </Text>
            {author && author !== title ? (
              <Text numberOfLines={1} className="text-xs text-muted-foreground">
                {author}
              </Text>
            ) : null}
            {metadata ? (
              <Text numberOfLines={1} className="text-xs text-muted-foreground">
                {metadata}
              </Text>
            ) : null}
          </View>
        </Pressable>
      </Link>
    );
  });
  return (
    <View
      testID={columns ? 'watch-video-recommendations' : undefined}
      className={columns ? 'gap-2 pt-1' : 'gap-2 px-[14px] pb-4 pt-4'}
    >
      <Text accessibilityRole="header" className="pb-2 text-base font-bold text-foreground">
        {t('videos.suggestions', { defaultValue: 'Suggested videos' })}
      </Text>
      {feed.isError ? (
        <Button appearance="subtle" onPress={() => void feed.refetch()}>
          {t('common.retry')}
        </Button>
      ) : !feed.isPending && !suggestions.length ? (
        <Text className="text-sm text-muted-foreground">
          {t('videos.noSuggestions', { defaultValue: 'No horizontal videos to suggest yet.' })}
        </Text>
      ) : null}
      <View className={columns ? 'gap-3' : 'gap-2'}>
        {columns
          ? Array.from({ length: Math.ceil(cards.length / columns) }, (_, rowIndex) => {
              const start = rowIndex * columns;
              const row = cards.slice(start, start + columns);
              return (
                <View key={row[0].key} className="flex-row gap-3">
                  {row}
                  {Array.from({ length: columns - row.length }, (_, index) => (
                    <View key={index} className="flex-1" />
                  ))}
                </View>
              );
            })
          : cards}
      </View>
    </View>
  );
}
