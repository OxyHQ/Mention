import React, { useCallback, useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Spinner } from '@/components/ui/Spinner';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { usePostsStore } from '@/stores/postsStore';
import { Ionicons } from '@expo/vector-icons';
import { EmptyState } from '@/components/common/EmptyState';
import { isDbAvailable } from '@/db';
import type { FeedItem } from '@/db';
import type { HydratedPostSummary, MediaItem } from '@mention/shared-types';
import VideoPosterCell from '@/components/common/VideoPosterCell';
import { isVideoMediaRef } from '@/utils/mediaTypes';
import { useProfileMediaFeed } from './useProfileMediaFeed';
import { ProfileGridList, type ProfileGridEntry } from './ProfileGridList';

interface MediaGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
}

interface MediaGridEntry extends ProfileGridEntry {
    uri: string;
    isVideo: boolean;
    isCarousel: boolean;
}

const CAROUSEL_ICON_SIZE = 12;
const INITIAL_RENDER_COUNT = 18;
const WINDOW_SIZE = 7;

/**
 * Fields the raw feed row can carry beyond the hydrated DTO contract (the feed
 * transform spreads the raw API row). Read defensively — all optional — for the
 * post-level video hint and the native SQLite by-id media fallback.
 */
interface RawPostExtras {
    type?: string;
    originalPostId?: string;
    boostOf?: string;
    quoteOf?: string;
}

// Grid image thumbnail from the server-resolved media object (`thumbUrl`,
// fallback `url`).
const resolveImageUri = (ref: MediaItem): string | undefined => ref.thumbUrl || ref.url || undefined;

// Static video poster from the server-resolved media object (`posterUrl`,
// fallback `thumbUrl`). Undefined → icon placeholder; a 404/error from the URL
// is handled by the cell's own image-error fallback.
const resolveVideoPosterUri = (ref: MediaItem): string | undefined => ref.posterUrl || ref.thumbUrl || undefined;

const MediaGrid: React.FC<MediaGridProps> = ({ userId, isPrivate, isOwnProfile }) => {
    const router = useRouter();
    const theme = useTheme();
    const { t } = useTranslation();
    const getPostFromDb = usePostsStore((s) => s.getPostFromDb);
    const { mediaFeed, postsFeed, items } = useProfileMediaFeed({ userId, isPrivate, isOwnProfile });

    const mediaItems = useMemo<MediaGridEntry[]>(() => {
        const out: MediaGridEntry[] = [];

        const pushUris = (targetId: string, sources: MediaItem[], postType?: string) => {
            const seen = new Set<string>();

            sources.forEach((ref, idx) => {
                // Dedup/video-detection key is the raw id/url; resolution reads the
                // object's server URLs first (handled inside the resolvers).
                const key = ref.id || ref.url;
                if (!key) return;
                const isVideo = isVideoMediaRef(key, { postType, mediaType: ref.type });

                if (seen.has(key)) return;
                seen.add(key);

                if (isVideo) {
                    // For videos the cell renders a static poster; an empty/unresolvable
                    // poster still produces a placeholder cell, so a video entry is
                    // always valid.
                    const posterUri = resolveVideoPosterUri(ref);
                    out.push({ postId: targetId, uri: posterUri ?? '', isVideo: true, isCarousel: sources.length > 1, mediaIndex: idx });
                    return;
                }

                const uri = resolveImageUri(ref);
                if (!uri) return; // Images require a resolvable uri.
                out.push({ postId: targetId, uri, isVideo: false, isCarousel: sources.length > 1, mediaIndex: idx });
            });
        };

        const extractFrom = (post: HydratedPostSummary & Partial<RawPostExtras>, targetId: string) => {
            // The server-resolved `content.media` objects carry the final URLs
            // (url/thumbUrl/posterUrl) — the single source for grid thumbnails.
            const media = post.content?.media;
            if (!Array.isArray(media) || media.length === 0) return;
            pushUris(targetId, media, post.type);
        };

        for (const rawPost of items) {
            const p: FeedItem & Partial<RawPostExtras> = rawPost;
            extractFrom(p, String(p.id));

            const ownMedia = p.content?.media;
            if (Array.isArray(ownMedia) && ownMedia.length > 0) continue;

            // Boosted/quoted media: the transformed feed item already carries the
            // related post objects (`original` / `quoted` / `boost.originalPost`).
            // Use those first — they work on web (no SQLite). On native we can also
            // fall back to the SQLite cache when the embedded object is absent.
            const embeddedOriginal = p.original ?? p.quoted ?? p.boost?.originalPost ?? null;
            if (embeddedOriginal) {
                extractFrom(embeddedOriginal, String(p.id));
                continue;
            }

            const origId = p.originalPostId || p.boostOf || p.quoteOf;
            if (origId && isDbAvailable()) {
                const orig = getPostFromDb(String(origId));
                if (orig) extractFrom(orig, String(p.id));
            }
        }

        return out;
    }, [items, getPostFromDb]);

    const renderCell = useCallback((item: MediaGridEntry, itemSize: number) => {
        const handlePress = () => {
            if (item.isVideo) {
                router.push(`/videos?postId=${item.postId}`);
            } else {
                router.push(`/p/${item.postId}`);
            }
        };

        return (
            <TouchableOpacity activeOpacity={0.8} style={{ width: itemSize, height: itemSize }} onPress={handlePress}>
                {item.isVideo ? (
                    <VideoPosterCell
                        posterUri={item.uri || undefined}
                        size={itemSize}
                        placeholderColor={theme.colors.textSecondary}
                        badge="center"
                    />
                ) : (
                    <Image
                        source={{ uri: item.uri }}
                        className="bg-secondary"
                        style={{ width: '100%', height: '100%' }}
                        contentFit="cover"
                        transition={150}
                        cachePolicy="memory-disk"
                    />
                )}
                {item.isCarousel && (
                    <View
                        className="absolute top-1 right-1 rounded p-0.5"
                        style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
                    >
                        <Ionicons name="albums-outline" size={CAROUSEL_ICON_SIZE} color="white" />
                    </View>
                )}
            </TouchableOpacity>
        );
    }, [router, theme.colors.textSecondary]);

    // Loading state first; if no items yet and feeds are still loading, show spinner
    const isLoading = (!mediaFeed && !postsFeed) || mediaFeed?.isLoading || postsFeed?.isLoading;
    if (isLoading && mediaItems.length === 0) {
        return (
            <View className="items-center justify-center p-8">
                <Spinner />
            </View>
        );
    }

    if (!isLoading && mediaItems.length === 0) {
        return (
            <EmptyState
                title={t('profile.media.empty.title', { defaultValue: 'No media posts yet' })}
                subtitle={t('profile.media.empty.subtitle', { defaultValue: 'Photos and videos you share will appear here.' })}
                icon={{
                    name: 'images-outline',
                    size: 48,
                }}
                containerStyle={{ flex: 1 }}
            />
        );
    }

    return (
        <ProfileGridList
            data={mediaItems}
            renderCell={renderCell}
            containerClassName="bg-background"
            initialNumToRender={INITIAL_RENDER_COUNT}
            windowSize={WINDOW_SIZE}
        />
    );
};

export default MediaGrid;
