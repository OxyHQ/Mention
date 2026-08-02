import React, { useCallback, useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Spinner } from '@/components/ui/Spinner';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services/ui/client';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { EmptyState } from '@/components/common/EmptyState';
import { Video } from '@/assets/icons/video-icon';
import { videoPosterUrl } from '@/utils/imageUrlCache';
import type { HydratedPostSummary, MediaItem } from '@mention/shared-types';
import VideoPosterCell from '@/components/common/VideoPosterCell';
import { isVideoMediaRef, readMediaDurationSec } from '@/utils/mediaTypes';
import { useProfileMediaFeed } from './useProfileMediaFeed';
import { ProfileGridList, type ProfileGridEntry } from './ProfileGridList';

interface VideosGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
    ownsScroll?: boolean;
    listHeaderComponent?: React.ReactElement | null;
    listStickyHeaderComponent?: React.ReactElement | null;
    contentContainerStyle?: React.ComponentProps<typeof View>['style'];
    onScroll?: React.ComponentProps<typeof ProfileGridList<VideoGridEntry>>['onScroll'];
    scrollRef?: React.ComponentProps<typeof ProfileGridList<VideoGridEntry>>['scrollRef'];
}

interface VideoGridEntry extends ProfileGridEntry {
    /**
     * Static poster URL: Oxy `thumb` variant for native assets, or the backend
     * `/media/poster` frame for federated videos. Undefined only when no sensible
     * poster exists; the cell falls back to a video-icon placeholder on
     * 404/load error too.
     */
    posterUri?: string;
    /**
     * Play count of the post this cell's video came from. Per-POST, so two
     * videos in one post repeat it.
     */
    views?: number | null;
    /** Duration of THIS item's video, in seconds. Per-item, so per-cell correct. */
    durationSec?: number;
}

const VideosGrid: React.FC<VideosGridProps> = ({
    userId,
    isPrivate,
    isOwnProfile,
    ownsScroll,
    listHeaderComponent,
    listStickyHeaderComponent,
    contentContainerStyle,
    onScroll,
    scrollRef,
}) => {
    const { oxyServices } = useAuth();
    const router = useRouter();
    const theme = useTheme();
    const { t } = useTranslation();
    const {
        primaryFeed,
        postsFeed,
        items,
        loadMore,
    } = useProfileMediaFeed({ userId, isPrivate, isOwnProfile, filter: 'videos' });

    /**
     * Resolve a static video still. Prefer the server-resolved `thumbUrl` — this
     * is a grid cell, and `posterUrl` is sized for a full-width player — falling
     * back to `posterUrl` and then to the legacy client resolver keyed on the
     * id/url (backend `/media/poster`). Both server fields are a still image for
     * a video of either origin, so preferring the smaller one is safe.
     * Undefined → icon placeholder. A 404/error from the URL is handled by the
     * cell's own image-error fallback.
     */
    const resolvePosterUri = useCallback(
        (ref: MediaItem): string | undefined => {
            const serverUrl = ref.thumbUrl || ref.posterUrl;
            if (serverUrl) return serverUrl;
            return videoPosterUrl(ref.id || ref.url || '', oxyServices);
        },
        [oxyServices],
    );

    const videoItems = useMemo<VideoGridEntry[]>(() => {
        const out: VideoGridEntry[] = [];

        const extractFrom = (post: HydratedPostSummary, targetId: string) => {
            const media = post.content?.media;
            if (!Array.isArray(media) || media.length === 0) return;

            const seen = new Set<string>();
            media.forEach((ref, idx) => {
                const key = ref.id || ref.url;
                if (!key) return;
                // Still per-ITEM even though the `videos` descriptor already
                // filtered server-side: that filter keeps POSTS, so a post mixing
                // one photo with one video is a legitimate result whose photo this
                // grid must drop — and the empty-primary posts fallback below is
                // unfiltered entirely.
                if (!isVideoMediaRef(key, { mediaType: ref.type })) return;
                if (seen.has(key)) return;
                seen.add(key);
                out.push({
                    postId: targetId,
                    posterUri: resolvePosterUri(ref),
                    mediaIndex: idx,
                    views: post.engagement?.views,
                    durationSec: readMediaDurationSec(ref),
                });
            });
        };

        items.forEach((post) => {
            if (!post.id) return;
            extractFrom(post, String(post.id));
        });

        return out;
    }, [items, resolvePosterUri]);

    const isLoading = (
        (!primaryFeed && !postsFeed) ||
        primaryFeed?.isLoading ||
        postsFeed?.isLoading
    ) && videoItems.length === 0;

    const renderCell = useCallback((item: VideoGridEntry, itemSize: number) => {
        const handlePress = () => {
            router.push(`/videos?postId=${item.postId}`);
        };

        return (
            <TouchableOpacity activeOpacity={0.8} style={{ width: itemSize, height: itemSize }} onPress={handlePress}>
                <VideoPosterCell
                    posterUri={item.posterUri}
                    size={itemSize}
                    placeholderColor={theme.colors.textSecondary}
                    views={item.views}
                    durationSec={item.durationSec}
                />
            </TouchableOpacity>
        );
    }, [router, theme.colors.textSecondary]);

    const emptyContent = isLoading
        ? (
            <View className="items-center justify-center p-8">
                <Spinner />
            </View>
        )
        : videoItems.length === 0
            ? (
            <EmptyState
                title={t('profile.videos.empty.title', { defaultValue: 'No videos yet' })}
                customIcon={<Video size={48} className="text-muted-foreground" />}
                containerStyle={{ flex: 1 }}
            />
            )
            : null;

    if (!ownsScroll && emptyContent) {
        return emptyContent;
    }

    return (
        <ProfileGridList
            data={videoItems}
            renderCell={renderCell}
            containerClassName="w-full"
            ownsScroll={ownsScroll}
            listHeaderComponent={listHeaderComponent}
            listStickyHeaderComponent={listStickyHeaderComponent}
            emptyComponent={emptyContent}
            contentContainerStyle={contentContainerStyle}
            onScroll={onScroll}
            scrollRef={scrollRef}
            onEndReached={loadMore}
        />
    );
};

export default VideosGrid;
