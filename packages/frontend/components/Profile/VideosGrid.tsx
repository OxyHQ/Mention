import React, { useCallback, useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Spinner } from '@/components/ui/Spinner';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { EmptyState } from '@/components/common/EmptyState';
import { Video } from '@/assets/icons/video-icon';
import { videoPosterUrl } from '@/utils/imageUrlCache';
import type { HydratedPostSummary, MediaItem } from '@mention/shared-types';
import VideoPosterCell from '@/components/common/VideoPosterCell';
import { isVideoMediaRef } from '@/utils/mediaTypes';
import { useProfileMediaFeed } from './useProfileMediaFeed';
import { ProfileGridList, type ProfileGridEntry } from './ProfileGridList';

interface VideosGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
}

interface VideoGridEntry extends ProfileGridEntry {
    /**
     * Static poster URL: Oxy `thumb` variant for native assets, or the backend
     * `/media/poster` frame for federated videos. Undefined only when no sensible
     * poster exists; the cell falls back to a video-icon placeholder on
     * 404/load error too.
     */
    posterUri?: string;
}

/** Post-level video hint the raw feed row may carry beyond the hydrated DTO. */
interface RawPostExtras {
    type?: string;
}

const VideosGrid: React.FC<VideosGridProps> = ({ userId, isPrivate, isOwnProfile }) => {
    const { oxyServices } = useAuth();
    const router = useRouter();
    const theme = useTheme();
    const { t } = useTranslation();
    const { mediaFeed, postsFeed, items } = useProfileMediaFeed({ userId, isPrivate, isOwnProfile });

    /**
     * Resolve a static video poster. Prefer the server-resolved final `posterUrl`
     * (fallback `thumbUrl`) from the media object; fall back to the legacy client
     * resolver keyed on the id/url (Oxy `thumb` / backend `/media/poster`).
     * Undefined → icon placeholder. A 404/error from the URL is handled by the
     * cell's own image-error fallback.
     */
    const resolvePosterUri = useCallback(
        (ref: MediaItem): string | undefined => {
            const serverUrl = ref.posterUrl || ref.thumbUrl;
            if (serverUrl) return serverUrl;
            return videoPosterUrl(ref.id || ref.url || '', oxyServices);
        },
        [oxyServices],
    );

    const videoItems = useMemo<VideoGridEntry[]>(() => {
        const out: VideoGridEntry[] = [];

        const extractFrom = (post: HydratedPostSummary & Partial<RawPostExtras>, targetId: string) => {
            const media = post.content?.media;
            if (!Array.isArray(media) || media.length === 0) return;

            const postType = post.type;
            const seen = new Set<string>();
            media.forEach((ref, idx) => {
                const key = ref.id || ref.url;
                if (!key) return;
                if (!isVideoMediaRef(key, { postType, mediaType: ref.type })) return; // Only include videos
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ postId: targetId, posterUri: resolvePosterUri(ref), mediaIndex: idx });
            });
        };

        items.forEach((post) => {
            if (!post.id) return;
            extractFrom(post, String(post.id));
        });

        return out;
    }, [items, resolvePosterUri]);

    const isLoading = (mediaFeed?.isLoading || postsFeed?.isLoading) && videoItems.length === 0;

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
                    badge="corner"
                />
            </TouchableOpacity>
        );
    }, [router, theme.colors.textSecondary]);

    if (isLoading) {
        return (
            <View className="items-center justify-center p-8">
                <Spinner />
            </View>
        );
    }

    if (videoItems.length === 0) {
        return (
            <EmptyState
                title={t('profile.videos.empty.title', { defaultValue: 'No videos yet' })}
                customIcon={<Video size={48} className="text-muted-foreground" />}
                containerStyle={{ flex: 1 }}
            />
        );
    }

    return (
        <ProfileGridList data={videoItems} renderCell={renderCell} containerClassName="w-full" />
    );
};

export default VideosGrid;
