import React, { useCallback, useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Spinner } from '@/components/ui/Spinner';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import { EmptyState } from '@/components/common/EmptyState';
import type { FeedItem } from '@/db';
import type { HydratedPostSummary, MediaItem } from '@mention/shared-types';
import LiveVideoPosterCell from './LiveVideoPosterCell';
import { isVideoMediaRef, readMediaDurationSec } from '@/utils/mediaTypes';
import { useProfileMediaFeed } from './useProfileMediaFeed';
import { ProfileGridList, type ProfileGridEntry } from './ProfileGridList';

interface MediaGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
    ownsScroll?: boolean;
    listHeaderComponent?: React.ReactElement | null;
    listStickyHeaderComponent?: React.ReactElement | null;
    contentContainerStyle?: React.ComponentProps<typeof View>['style'];
    onScroll?: React.ComponentProps<typeof ProfileGridList<MediaGridEntry>>['onScroll'];
    scrollRef?: React.ComponentProps<typeof ProfileGridList<MediaGridEntry>>['scrollRef'];
}

interface MediaGridEntry extends ProfileGridEntry {
    uri: string;
    isVideo: boolean;
    isCarousel: boolean;
    /**
     * Play count of the post this cell's media came from — set on video entries
     * only, so the type says outright that image cells carry neither of these.
     * Per-POST, so two videos in one post repeat it, exactly as `isCarousel`
     * already paints on every one of a post's cells. Fetch-time value: the cell
     * prefers the live count from the shared cache when the post is in it.
     */
    views?: number | null;
    /**
     * The post {@link MediaGridEntry.views} describes, which is NOT always
     * {@link ProfileGridEntry.postId}: a boost/quote with no media of its own
     * borrows the ORIGINAL's media, and `postId` stays the outer post so the tap
     * still opens what the viewer sees on the profile. Subscribing to `postId`
     * there would paint the BOOST's count under the original's video.
     */
    viewsPostId?: string;
    /** Duration of THIS item's video, in seconds. Per-item, so per-cell correct. */
    durationSec?: number;
}

const CAROUSEL_ICON_SIZE = 12;
const INITIAL_RENDER_COUNT = 18;
const WINDOW_SIZE = 7;

// Grid image thumbnail from the server-resolved media object (`thumbUrl`,
// fallback `url`).
const resolveImageUri = (ref: MediaItem): string | undefined => ref.thumbUrl || ref.url || undefined;

// Static video poster from the server-resolved media object (`posterUrl`,
// fallback `thumbUrl`). Undefined → icon placeholder; a 404/error from the URL
// is handled by the cell's own image-error fallback.
const resolveVideoPosterUri = (ref: MediaItem): string | undefined => ref.posterUrl || ref.thumbUrl || undefined;

const MediaGrid: React.FC<MediaGridProps> = ({
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
    const router = useRouter();
    const theme = useTheme();
    const { t } = useTranslation();
    const {
        primaryFeed,
        postsFeed,
        items,
        loadMore,
    } = useProfileMediaFeed({ userId, isPrivate, isOwnProfile });

    const mediaItems = useMemo<MediaGridEntry[]>(() => {
        const out: MediaGridEntry[] = [];

        const pushUris = (post: HydratedPostSummary, targetId: string, sources: MediaItem[]) => {
            const seen = new Set<string>();

            sources.forEach((ref, idx) => {
                // Dedup/video-detection key is the raw id/url; resolution reads the
                // object's server URLs first (handled inside the resolvers).
                const key = ref.id || ref.url;
                if (!key) return;
                const isVideo = isVideoMediaRef(key, { mediaType: ref.type });

                if (seen.has(key)) return;
                seen.add(key);

                if (isVideo) {
                    // For videos the cell renders a static poster; an empty/unresolvable
                    // poster still produces a placeholder cell, so a video entry is
                    // always valid.
                    const posterUri = resolveVideoPosterUri(ref);
                    out.push({
                        postId: targetId,
                        uri: posterUri ?? '',
                        isVideo: true,
                        isCarousel: sources.length > 1,
                        mediaIndex: idx,
                        // `post`, not the outer feed item: for a boost/quote with no
                        // media of its own the media belongs to the ORIGINAL, and the
                        // count has to describe the video being shown. The live
                        // subscription has to follow that same post, hence the id.
                        views: post.engagement?.views,
                        viewsPostId: post.id ? String(post.id) : undefined,
                        durationSec: readMediaDurationSec(ref),
                    });
                    return;
                }

                const uri = resolveImageUri(ref);
                if (!uri) return; // Images require a resolvable uri.
                out.push({ postId: targetId, uri, isVideo: false, isCarousel: sources.length > 1, mediaIndex: idx });
            });
        };

        const extractFrom = (post: HydratedPostSummary, targetId: string) => {
            // The server-resolved `content.media` objects carry the final URLs
            // (url/thumbUrl/posterUrl) — the single source for grid thumbnails.
            const media = post.content?.media;
            if (!Array.isArray(media) || media.length === 0) return;
            pushUris(post, targetId, media);
        };

        for (const rawPost of items) {
            const p: FeedItem = rawPost;
            extractFrom(p, String(p.id));

            const ownMedia = p.content?.media;
            if (Array.isArray(ownMedia) && ownMedia.length > 0) continue;

            // Related media is embedded by the canonical hydrated contract, so it
            // works identically on web and native without a second SQLite lookup.
            const embeddedOriginal =
                p.boost?.originalPost ?? p.quotedPost ?? p.originalPost ?? null;
            if (embeddedOriginal) {
                extractFrom(embeddedOriginal, String(p.id));
            }
        }

        return out;
    }, [items]);

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
                    <LiveVideoPosterCell
                        posterUri={item.uri || undefined}
                        size={itemSize}
                        placeholderColor={theme.colors.textSecondary}
                        viewsPostId={item.viewsPostId}
                        fallbackViews={item.views}
                        durationSec={item.durationSec}
                        scrim
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
    const isLoading = (!primaryFeed && !postsFeed) || primaryFeed?.isLoading || postsFeed?.isLoading;
    const emptyContent = isLoading && mediaItems.length === 0
        ? (
            <View className="items-center justify-center p-8">
                <Spinner />
            </View>
        )
        : !isLoading && mediaItems.length === 0
            ? (
            <EmptyState
                title={t('profile.media.empty.title', { defaultValue: 'No media posts yet' })}
                subtitle={t('profile.media.empty.subtitle', { defaultValue: 'Photos and videos you share will appear here.' })}
                icon={{
                    name: 'images-outline',
                    size: 48,
                }}
                containerStyle={{ flex: 1 }}
            />
            )
            : null;

    if (!ownsScroll && emptyContent) {
        return emptyContent;
    }

    return (
        <ProfileGridList
            data={mediaItems}
            renderCell={renderCell}
            containerClassName="bg-background"
            initialNumToRender={INITIAL_RENDER_COUNT}
            windowSize={WINDOW_SIZE}
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

export default MediaGrid;
