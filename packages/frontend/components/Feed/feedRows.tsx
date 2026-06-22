import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { useRouter } from 'expo-router';
import {
    FeedType,
    HydratedPost,
    Reply,
    FeedBoost as Boost,
    FeedPostSlice,
    FeedSliceReason,
} from '@mention/shared-types';
import PostItem from './PostItem';
import { PostErrorBoundary } from './PostErrorBoundary';
import { createScopedLogger } from '@/lib/logger';
import { getItemKey, deduplicateItems, buildReplyTree, ReplyNode } from '@/utils/feedUtils';
import { THREAD_LINE_WIDTH, THREAD_LINE_BORDER_RADIUS, THREAD_LINE_Z_INDEX } from '@/components/Compose/composeLayout';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { extractAuthorId } from '@/utils/postUtils';

/**
 * Shared feed-row model + render helpers used by BOTH the native (FlashList)
 * and web (window-virtualizer) Feed implementations. Keeping the row-transform
 * and renderer in ONE place guarantees native and web build identical rows from
 * the same `useFeedState` data — only the scroll host differs per platform.
 *
 * This module is platform-agnostic: it must never touch `window`/`document` or
 * any web-only API, because the native bundle imports it.
 */

// Type alias for feed items (what PostItem expects)
export type FeedItem = HydratedPost | Reply | Boost;

/**
 * Optional/legacy fields probed on a feed item for thread classification and
 * "my recent post to top" sorting. These are NOT all present on the hydrated
 * shape: `isLocalNew`/`date` come from optimistic local inserts, and
 * `original`/`boostOf`/`quoted`/`quoteOf`/`replyTo` are raw/legacy aliases for
 * the hydrated `originalPost`/`quotedPost`/`parentPostId` nested references.
 * Reading them through this view avoids `as any` while keeping the defensive
 * runtime checks intact.
 */
export type FeedItemProbe = FeedItem & {
    isLocalNew?: boolean;
    date?: string;
    createdAt?: string;
    original?: unknown;
    boostOf?: unknown;
    quoted?: unknown;
    quoteOf?: unknown;
    replyTo?: unknown;
};

// Row type with thread state — the unit both list implementations render.
export interface FeedRow {
    item: FeedItem;
    sliceKey: string;
    isThreadParent: boolean;
    isThreadChild: boolean;
    isThreadLastChild: boolean;
    isIncompleteThread: boolean;
    sliceReason?: FeedSliceReason;
    nestingDepth: number;
    truncatedChildCount: number;
}

export const MAX_THREAD_NESTING_DEPTH = 3;

const logger = createScopedLogger('Feed');

export interface BuildFeedRowsParams {
    slices?: FeedPostSlice[];
    items: HydratedPost[];
    type: FeedType;
    showOnlySaved?: boolean;
    currentUserId?: string;
    blockedSet: Set<string>;
    threaded?: boolean;
    threadPostId?: string;
}

/**
 * Transform slices (or flat items) into {@link FeedRow}s with thread state.
 * Extracted verbatim from the original Feed.tsx `feedRows` memo so the row set
 * is identical on every platform.
 */
export function buildFeedRows({
    slices,
    items: src,
    type,
    showOnlySaved,
    currentUserId,
    blockedSet,
    threaded,
    threadPostId,
}: BuildFeedRowsParams): FeedRow[] {
    // If we have slices, transform them into FeedRows with thread state
    if (slices && slices.length > 0) {
        const rows: FeedRow[] = [];
        for (const slice of slices) {
            for (let i = 0; i < slice.items.length; i++) {
                const sliceItem = slice.items[i];
                const post = sliceItem.post as FeedItem;
                if (!post || !post.id) continue;

                // Privacy filter
                if (blockedSet.size > 0) {
                    const authorId = extractAuthorId(post);
                    if (authorId && blockedSet.has(authorId)) continue;
                }

                rows.push({
                    item: post,
                    sliceKey: slice._sliceKey,
                    isThreadParent: i < slice.items.length - 1,
                    isThreadChild: i > 0,
                    isThreadLastChild: i === slice.items.length - 1 && i > 0,
                    isIncompleteThread: slice.isIncompleteThread,
                    sliceReason: slice.reason,
                    nestingDepth: 0,
                    truncatedChildCount: 0,
                });
            }
        }
        return rows;
    }

    // Fallback: wrap flat items into single-post FeedRows (no thread state)
    if (src.length === 0) return [];

    const deduped = deduplicateItems(src, getItemKey);
    const filteredByPrivacy = blockedSet.size > 0
        ? deduped.filter((item) => {
            const authorId = extractAuthorId(item);
            return authorId ? !blockedSet.has(authorId) : true;
        })
        : deduped;

    // Threaded mode: build reply tree and flatten with nesting depth
    if (threaded && threadPostId && filteredByPrivacy.length > 0) {
        const tree = buildReplyTree(filteredByPrivacy, threadPostId);
        const rows: FeedRow[] = [];

        const flattenNode = (node: ReplyNode, depth: number) => {
            const item = node.reply as FeedItem;
            const isTruncated = depth >= MAX_THREAD_NESTING_DEPTH && node.children.length > 0;

            rows.push({
                item,
                sliceKey: getItemKey(item),
                isThreadParent: node.children.length > 0 && !isTruncated,
                isThreadChild: depth > 0,
                isThreadLastChild: false,
                isIncompleteThread: isTruncated,
                nestingDepth: depth,
                truncatedChildCount: isTruncated ? node.children.length : 0,
            });

            if (!isTruncated) {
                for (const child of node.children) {
                    flattenNode(child, depth + 1);
                }
            }
        };

        for (const node of tree) {
            flattenNode(node, 0);
        }

        return rows;
    }

    // Sort recent user posts to top for for_you feed
    let finalItems = filteredByPrivacy;
    const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
    if (effectiveType === 'for_you' && currentUserId && filteredByPrivacy.length > 0) {
        const now = Date.now();
        const THRESHOLD_MS = 60 * 1000;
        const mineNow: { item: FeedItem; ts: number }[] = [];
        const others: FeedItem[] = [];

        for (const item of filteredByPrivacy) {
            const probe = item as FeedItemProbe;
            const ownerId = probe.user?.id;
            if (probe.isLocalNew || ownerId === currentUserId) {
                const d = probe.date || probe.createdAt;
                const ts = d ? Date.parse(d) : 0;
                if (ts && now - ts <= THRESHOLD_MS) {
                    mineNow.push({ item, ts });
                } else {
                    others.push(item);
                }
            } else {
                others.push(item);
            }
        }

        if (mineNow.length > 0) {
            mineNow.sort((a, b) => b.ts - a.ts);
            finalItems = [...mineNow.map((x) => x.item), ...others];
        }
    }

    return finalItems.map((item) => ({
        item,
        sliceKey: getItemKey(item),
        isThreadParent: false,
        isThreadChild: false,
        isThreadLastChild: false,
        isIncompleteThread: false,
        nestingDepth: 0,
        truncatedChildCount: 0,
    }));
}

/** Stable key for a feed row (slice-scoped). */
export function feedRowKey(row: FeedRow): string {
    const itemId = getItemKey(row.item);
    return row.sliceKey !== itemId ? `${row.sliceKey}:${itemId}` : itemId;
}

/** Recycle/type bucket for a feed row. Used by FlashList recycling on native. */
export function feedRowType(row: FeedRow): string {
    if (row.nestingDepth > 0) return `nested_${row.nestingDepth}`;
    if (row.isThreadParent) return 'threadParent';
    if (row.isThreadChild) return 'threadChild';
    const item = row.item as FeedItemProbe;
    if (item.original || item.boostOf) return 'boost';
    if (item.quoted || item.quoteOf) return 'quote';
    if ((item as { parentPostId?: unknown }).parentPostId || item.replyTo) return 'reply';
    return 'post';
}

export interface RenderFeedRowDeps {
    router: ReturnType<typeof useRouter>;
    primaryColor: string;
}

/**
 * Render a single feed row (PostItem + thread/slice affordances). Shared by both
 * platform Feed implementations so the row markup never diverges.
 */
export function renderFeedRow(row: FeedRow, { router, primaryColor }: RenderFeedRowDeps): React.ReactElement | null {
    const post = row.item;
    if (!post || !post.id) {
        logger.warn('Invalid post item', { post });
        return null;
    }

    const showThreadLink = row.isIncompleteThread && row.isThreadLastChild;
    const showMoreReplies = row.isIncompleteThread && row.truncatedChildCount > 0;
    const replyContextAuthor = row.isThreadChild && row.sliceReason?.type === 'replyContext'
        ? row.sliceReason.parentAuthor
        : undefined;
    const nestPadding = row.nestingDepth > 0 ? { paddingLeft: 16 * row.nestingDepth } : undefined;

    const content = (
        <PostErrorBoundary postId={post.id}>
            {replyContextAuthor && (
                <View style={styles.replyContextLabel}>
                    <Text className="text-muted-foreground text-xs">
                        Replying to <Text className="text-primary text-xs">@{replyContextAuthor.handle || replyContextAuthor.displayName}</Text>
                    </Text>
                </View>
            )}
            <PostItem
                post={post}
                isThreadParent={row.isThreadParent}
                isThreadChild={row.isThreadChild}
                isThreadLastChild={row.isThreadLastChild}
                nestingDepth={row.nestingDepth}
            />
            {showThreadLink && (
                <Pressable
                    className="border-border"
                    style={styles.showThreadLink}
                    onPress={() => router.push(`/p/${post.id}`)}
                >
                    <Text className="text-primary text-sm font-medium">
                        Show this thread
                    </Text>
                </Pressable>
            )}
            {showMoreReplies && (
                <Pressable
                    style={[styles.showMoreReplies, nestPadding]}
                    onPress={() => router.push(`/p/${post.id}`)}
                >
                    <Text className="text-primary text-sm font-medium">
                        Show more replies ({row.truncatedChildCount})
                    </Text>
                </Pressable>
            )}
        </PostErrorBoundary>
    );

    if (nestPadding) {
        return (
            <View style={[styles.nestedRow, nestPadding]}>
                <View style={[styles.nestedThreadLine, { backgroundColor: `${primaryColor}30` }]} />
                {content}
            </View>
        );
    }

    return content;
}

export const feedRowStyles = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: 0,
    },
    list: {
        flex: 1,
        minHeight: 0,
    },
    listEmbedded: {
        // When embedded inside a parent ScrollView (scrollEnabled=false),
        // avoid flex: 1 so the list sizes to its content instead of collapsing.
        minHeight: 0,
    },
    listContent: {
        flexGrow: 0,
        alignSelf: 'stretch',
    },
});

const styles = StyleSheet.create({
    showThreadLink: {
        paddingVertical: 10,
        // Align with PostItem content (after avatar): HPAD + AVATAR_SIZE + AVATAR_GAP = 64
        paddingLeft: POST_ITEM_SPACING.AVATAR_OFFSET,
        paddingRight: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    replyContextLabel: {
        // Align with PostItem content (after avatar): HPAD + AVATAR_SIZE + AVATAR_GAP = 64
        paddingLeft: POST_ITEM_SPACING.AVATAR_OFFSET,
        paddingTop: 8,
        paddingBottom: 2,
    },
    nestedRow: {
        position: 'relative',
    },
    nestedThreadLine: {
        position: 'absolute',
        // Center the thread line on the PostItem avatar: HPAD + AVATAR_SIZE/2 - 1 = 31
        left: POST_ITEM_SPACING.HPAD + POST_ITEM_SPACING.AVATAR_SIZE / 2 - 1,
        top: 0,
        bottom: 0,
        width: THREAD_LINE_WIDTH,
        borderRadius: THREAD_LINE_BORDER_RADIUS,
        zIndex: THREAD_LINE_Z_INDEX,
    },
    showMoreReplies: {
        paddingVertical: 10,
        paddingLeft: 16,
        paddingRight: 12,
    },
});
