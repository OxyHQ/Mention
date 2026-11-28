import type React from 'react';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';
import VideoPosterCell from '@/components/common/VideoPosterCell';
import { MediaGridSkeleton } from '@/components/loading/ContentSkeleton';
import { Link, useRouter } from '@/lib/navigation/router';
import { useViewCountSelector } from '@/stores/postsStore';
import { isLandscapeVideo, isVideoMediaRef, readMediaDurationSec } from '@/utils/mediaTypes';
import { videoPosterUrl } from '@/utils/mediaUrls';
import { videoPublicationDate, videoViewCount } from '@/components/videos/videoMetadata';
import { useProfileMediaFeed } from './useProfileMediaFeed';
import { ProfileGridList, type ProfileGridEntry } from './ProfileGridList';
import type { ProfileGridLayout } from './ProfileGridList.types';

interface VideosGridProps {
  userId?: string;
  isPrivate?: boolean;
  isOwnProfile?: boolean;
  ownsScroll?: boolean;
  listHeaderComponent?: React.ReactElement | null;
  listContentHeaderComponent?: React.ReactElement | null;
  listStickyHeaderComponent?: React.ReactElement | null;
  contentContainerStyle?: React.ComponentProps<typeof View>['style'];
}

interface VideoGridEntry extends ProfileGridEntry {
  title?: string;
  posterUri?: string;
  views?: number | null;
  durationSec?: number;
  createdAt: string;
  landscape: boolean;
}

const thumbnailHeight = (width: number) => Math.round((width * 9) / 16);
const profileVideoLayout: ProfileGridLayout = {
  columns: 2,
  gap: 12,
  inset: 12,
  cellHeight: (width) => thumbnailHeight(width) + 76,
};

function ProfileVideoCard({ video, width }: { video: VideoGridEntry; width: number }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const liveViews = useViewCountSelector(video.postId);
  const views = videoViewCount(t, locale, liveViews === undefined ? video.views : liveViews, true);
  const date = videoPublicationDate(video.createdAt, locale).relative;
  const metadata = [views, date].filter(Boolean).join(' · ');
  const title = video.title || t('videos.reel', { defaultValue: 'Video' });
  const index = String(video.mediaIndex);
  const destination = video.landscape
    ? { pathname: '/watch/[id]' as const, params: { id: video.postId, mediaIndex: index } }
    : { pathname: '/videos' as const, params: { postId: video.postId, mediaIndex: index } };

  return (
    <Link href={destination} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={title}
        testID="profile-video-card"
        className="gap-2 rounded-xl pb-2 hover:bg-muted focus-visible:bg-muted"
        style={{ width }}
      >
        <View className="overflow-hidden rounded-xl">
          <VideoPosterCell
            posterUri={video.posterUri}
            size={width}
            height={thumbnailHeight(width)}
            contentFit={video.landscape ? 'cover' : 'contain'}
            placeholderColor={theme.colors.textSecondary}
            durationSec={video.durationSec}
          />
        </View>
        <View className="min-w-0 gap-1 px-1">
          <Text numberOfLines={2} className="text-sm font-semibold leading-5 text-foreground">
            {title}
          </Text>
          {metadata ? (
            <Text numberOfLines={1} className="text-xs leading-4 text-muted-foreground">
              {metadata}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Link>
  );
}

export default function VideosGrid({
  userId,
  isPrivate,
  isOwnProfile,
  ownsScroll,
  listHeaderComponent,
  listContentHeaderComponent,
  listStickyHeaderComponent,
  contentContainerStyle,
}: VideosGridProps) {
  const { oxyServices } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const { primaryFeed, postsFeed, items, loadMore, restorationKey } = useProfileMediaFeed({
    userId,
    isPrivate,
    isOwnProfile,
    filter: 'videos',
  });

  const videos = useMemo<VideoGridEntry[]>(() => {
    return items.flatMap((post) => {
      if (!post.id) return [];
      const seen = new Set<string>();
      const media = post.content.media ?? post.attachments.media ?? [];
      return media.flatMap((ref, mediaIndex) => {
        const key = ref.id || ref.url || '';
        if (!key || seen.has(key) || !isVideoMediaRef(key, { mediaType: ref.type })) return [];
        seen.add(key);
        return [
          {
            postId: post.id,
            mediaIndex,
            title: post.content.title?.trim() || post.content.text?.trim(),
            posterUri: post.metadata.isSensitive
              ? undefined
              : ref.thumbUrl || ref.posterUrl || videoPosterUrl(key, oxyServices),
            views: post.engagement.views,
            durationSec: readMediaDurationSec(ref),
            createdAt: post.metadata.createdAt,
            landscape: isLandscapeVideo(ref),
          },
        ];
      });
    });
  }, [items, oxyServices]);

  const isLoading =
    ((!primaryFeed && !postsFeed) || primaryFeed?.isLoading || postsFeed?.isLoading) &&
    videos.length === 0;
  const emptyContent = isLoading ? (
    <MediaGridSkeleton />
  ) : videos.length === 0 ? (
    <EmptyState
      title={t('profile.videos.empty.title', { defaultValue: 'No videos yet' })}
      sticker="profileVideos"
      containerStyle={{ flex: 1 }}
    />
  ) : null;
  const gridHeader = isOwnProfile ? (
    <View className="items-end px-3 py-3">
      <Button size="sm" appearance="outline" onPress={() => router.push('/video-upload')}>
        {t('videos.upload', { defaultValue: 'Upload video' })}
      </Button>
    </View>
  ) : videos.length > 0 ? (
    <View className="h-3" />
  ) : null;

  return (
    <ProfileGridList
      restorationKey={restorationKey}
      data={videos}
      renderCell={(video, width) => <ProfileVideoCard video={video} width={width} />}
      containerClassName="w-full"
      layout={profileVideoLayout}
      leadingComponent={gridHeader}
      ownsScroll={ownsScroll}
      listHeaderComponent={listHeaderComponent}
      listContentHeaderComponent={listContentHeaderComponent}
      listStickyHeaderComponent={listStickyHeaderComponent}
      emptyComponent={emptyContent}
      contentContainerStyle={contentContainerStyle}
      onEndReached={loadMore}
    />
  );
}
