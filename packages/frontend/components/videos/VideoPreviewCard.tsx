import type { ReactElement } from 'react';
import { Image } from 'expo-image';
import type { TFunction } from 'i18next';
import { Pressable, Text, View } from 'react-native';
import { getNormalizedUserHandle } from '@oxy.so/core';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { Link, type Href } from '@/lib/navigation/router';
import { formatDuration } from '@/utils/formatDuration';
import { videoPublicationDate, videoTitleText, videoViewCount } from './videoMetadata';
import type { VideoPreview } from './watchVideo';

export function VideoPreviewCard({
  video,
  clip = false,
  locale,
  t,
}: {
  video: VideoPreview;
  clip?: boolean;
  locale: string;
  t: TFunction;
}) {
  const { post, mediaIndex, poster, duration } = video;
  const handle = getNormalizedUserHandle(post.user);
  const author = post.user.name?.displayName || (handle ? `@${handle}` : '');
  const title =
    videoTitleText(post.content.title) ||
    videoTitleText(post.content.text) ||
    author ||
    t('videos.reel');
  const views = videoViewCount(t, locale, post.engagement.views, true);
  const metadata = clip
    ? views
    : [views, videoPublicationDate(post.metadata.createdAt, locale).relative]
        .filter(Boolean)
        .join(' · ');
  const href: Href = clip
    ? { pathname: '/videos', params: { postId: post.id, mediaIndex: String(mediaIndex) } }
    : { pathname: '/watch/[id]', params: { id: post.id, mediaIndex: String(mediaIndex) } };
  const cardInset = clip ? 'px-[3px] py-1' : 'px-1 py-1';
  const thumbnailSize = clip ? 'aspect-[9/16]' : 'aspect-video';

  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={author && author !== title ? `${title}, ${author}` : title}
        className={`min-w-0 w-full gap-2.5 rounded-2xl hover:bg-muted focus-visible:bg-muted ${cardInset}`}
      >
        <View
          className={`${thumbnailSize} w-full items-center justify-center overflow-hidden rounded-xl bg-muted`}
        >
          {poster && !post.metadata.isSensitive ? (
            <Image source={poster} contentFit="cover" style={{ width: '100%', height: '100%' }} />
          ) : (
            <RiVideoLine size="md" color="currentColor" />
          )}
          {duration !== undefined && !clip && (
            <Text className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
              {formatDuration(duration)}
            </Text>
          )}
        </View>
        <View className="min-w-0 flex-row gap-2 px-0.5">
          {!clip && (
            <Avatar
              source={post.user.avatar ?? undefined}
              size={32}
              variant={MEDIA_VARIANT_AVATAR}
            />
          )}
          <View className="min-w-0 flex-1 gap-1">
            <Text
              numberOfLines={2}
              className={
                !clip
                  ? 'text-base font-semibold text-foreground'
                  : 'text-sm font-semibold text-foreground'
              }
            >
              {title}
            </Text>
            {author && author !== title && !clip ? (
              <Text numberOfLines={1} className="text-sm text-muted-foreground">
                {author}
              </Text>
            ) : null}
            {metadata ? (
              <Text numberOfLines={1} className="text-xs text-muted-foreground">
                {metadata}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

export function VideoPreviewGrid({ cards, columns }: { cards: ReactElement[]; columns: number }) {
  return (
    <View className="gap-1">
      {Array.from({ length: Math.ceil(cards.length / columns) }, (_, rowIndex) => {
        const start = rowIndex * columns;
        const row = cards.slice(start, start + columns);
        return (
          <View key={row[0].key} className="flex-row gap-0.5">
            {row.map((card) => (
              <View key={card.key} className="min-w-0 flex-1">
                {card}
              </View>
            ))}
            {Array.from({ length: columns - row.length }, (_, index) => (
              <View key={index} className="flex-1" />
            ))}
          </View>
        );
      })}
    </View>
  );
}

export function VideoPreviewSkeleton({ clip = false }: { clip?: boolean }) {
  return (
    <View className={clip ? 'gap-2 px-[3px] py-1' : 'gap-2 px-1 py-1'}>
      <Skeleton.Box
        width="100%"
        style={{ aspectRatio: clip ? 9 / 16 : 16 / 9 }}
        borderRadius={12}
      />
      <Skeleton.Box width="88%" height={16} borderRadius={6} />
      <Skeleton.Box width="55%" height={12} borderRadius={5} />
    </View>
  );
}
