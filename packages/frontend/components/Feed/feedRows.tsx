import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { useRouter } from 'expo-router';
import type {
    FeedType,
    HydratedPost,
    HydratedPostSummary,
    PostUser,
    Reply,
    FeedBoost as Boost,
    FeedInterstitialSlot,
    FeedPostSlice,
    FeedSliceReason,
} from '@mention/shared-types';
import PostItem from './PostItem';
import { PostErrorBoundary } from './PostErrorBoundary';
import FeedInterstitial from './interstitials/FeedInterstitial';
import { SubtleHover } from '@oxyhq/bloom/subtle-hover';
import { useThreadHoverStore } from '@/stores/threadHoverStore';
import { createLogger } from '@oxyhq/core/logger';
import { getItemKey, deduplicateItems, buildReplyTree, ReplyNode } from '@/utils/feedUtils';
import { THREAD_LINE_WIDTH, THREAD_LINE_BORDER_RADIUS, THREAD_LINE_Z_INDEX } from '@/components/Compose/composeLayout';
import { POST_ITEM_SPACING } from '@/styles/shared';

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
 * Local-only fields used for "my recent post to top" sorting. They are added by
 * the cache/optimistic-write boundary and never appear on the API DTO.
 */
type FeedItemProbe = FeedItem & {
    isLocalNew?: boolean;
    date?: string;
};

// A post row: one hydrated post plus its thread state.
export interface PostFeedRow {
    kind: 'post';
    item: FeedItem;
    sliceKey: string;
    isThreadParent: boolean;
    isThreadChild: boolean;
    isThreadLastChild: boolean;
    isIncompleteThread: boolean;
    sliceReason?: FeedSliceReason;
    nestingDepth: number;
    truncatedChildCount: number;
    /**
     * For rows that belong to a real multi-post thread (slice with >1 item), the
     * id of the thread's ROOT post (the first slice item). Tapping any post of
     * the thread opens this root so the whole thread is shown. Undefined for
     * standalone posts (single-item slices), which open their own detail.
     */
    threadRootId?: string;
}

// A recommendation card spliced between post slices. The row carries only the
// server's PLACEMENT (which kind of card, and where); the card component fetches
// its own content, so the feed never blocks on recommendation data.
export interface InterstitialFeedRow {
    kind: 'interstitial';
    slot: FeedInterstitialSlot;
    /**
     * Position among ALL interstitials of the accumulated feed (0, 1, 2 …). The
     * card pages its content off this, so consecutive cards of the same kind
     * don't show the same suggestions.
     */
    ordinal: number;
}

// The unit both list implementations render.
export type FeedRow = PostFeedRow | InterstitialFeedRow;

export const MAX_THREAD_NESTING_DEPTH = 3;

const logger = createLogger('Feed');

export interface BuildFeedRowsParams {
    slices?: FeedPostSlice[];
    items: HydratedPost[];
    type: FeedType;
    showOnlySaved?: boolean;
    currentUserId?: string;
    blockedSet: Set<string>;
    threaded?: boolean;
    threadPostId?: string;
    /** Server-decided recommendation-card placements for the accumulated feed. */
    interstitials?: FeedInterstitialSlot[];
}

/**
 * Splice the server's recommendation slots into the post rows: a slot renders
 * directly after the LAST row of the slice it is anchored to, so a card never
 * lands inside a thread.
 *
 * A slot whose anchor slice produced no row — its posts were all dropped by the
 * blocked-author filter — is DISCARDED, never re-anchored: a card must not drift
 * to an unrelated position just because the client filtered a post.
 *
 * `ordinal` numbers the slots actually emitted, in feed order.
 */
function spliceInterstitials(
    rows: PostFeedRow[],
    interstitials?: FeedInterstitialSlot[],
): FeedRow[] {
    if (!interstitials || interstitials.length === 0 || rows.length === 0) return rows;

    const slotsByAnchor = new Map<string, FeedInterstitialSlot[]>();
    for (const slot of interstitials) {
        const anchored = slotsByAnchor.get(slot.afterSliceKey);
        if (anchored) {
            anchored.push(slot);
        } else {
            slotsByAnchor.set(slot.afterSliceKey, [slot]);
        }
    }

    // Last row index of every anchored slice. A thread slice yields several rows;
    // the card belongs after the whole thread, not between its posts.
    const anchorRowIndex = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
        const { sliceKey } = rows[i];
        if (slotsByAnchor.has(sliceKey)) anchorRowIndex.set(sliceKey, i);
    }

    const out: FeedRow[] = [];
    let ordinal = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        out.push(row);
        if (anchorRowIndex.get(row.sliceKey) !== i) continue;
        const slots = slotsByAnchor.get(row.sliceKey);
        if (!slots) continue;
        for (const slot of slots) {
            out.push({ kind: 'interstitial', slot, ordinal });
            ordinal += 1;
        }
    }
    return out;
}

/**
 * Final virtualizer-safety boundary. Upstream page normalization should already
 * make every post/slot unique, but this guarantees React/FlashList never receive
 * duplicate row keys if a legacy cache or malformed response bypasses it.
 */
export function ensureUniqueFeedRows(rows: FeedRow[]): FeedRow[] {
    const seen = new Set<string>();
    return rows.filter((row) => {
        const key = feedRowKey(row);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Transform slices (or flat items) into {@link FeedRow}s with thread state, then
 * splice in the server's recommendation cards. Pure: it decides only WHERE a card
 * goes, never what is inside it — which is what keeps the `useDeepCompareMemo`
 * wrapper around it correct.
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
    interstitials,
}: BuildFeedRowsParams): FeedRow[] {
    // If we have slices, transform them into FeedRows with thread state
    if (slices && slices.length > 0) {
        const rows: PostFeedRow[] = [];
        const seenPostIds = new Set<string>();
        for (const slice of slices) {
            // A ranking boundary can overlap the preceding page. Normalize every
            // slice before deriving thread flags so removing a duplicate parent or
            // child cannot leave impossible thread positions behind.
            const uniqueSliceItems = slice.items.filter((sliceItem) => {
                const post = sliceItem.post as FeedItem;
                if (!post || !post.id) return false;
                if (blockedSet.size > 0) {
                    const authorId = post.user?.id;
                    if (authorId && blockedSet.has(authorId)) return false;
                }
                const postId = getItemKey(post);
                if (!postId || seenPostIds.has(postId)) return false;
                seenPostIds.add(postId);
                return true;
            });
            if (uniqueSliceItems.length === 0) continue;

            // Real threads (multi-post slices) share one root: the FIRST item's
            // post. Every row of the thread carries it so a tap opens the whole
            // thread at its root. Standalone slices (one item) leave it undefined.
            const threadRootId = slice.items.length > 1
                ? String(slice.items[0]?.post?.id ?? '')
                : undefined;
            for (let i = 0; i < uniqueSliceItems.length; i++) {
                const sliceItem = uniqueSliceItems[i];
                const post = sliceItem.post as FeedItem;

                rows.push({
                    kind: 'post',
                    item: post,
                    sliceKey: slice._sliceKey,
                    isThreadParent: i < uniqueSliceItems.length - 1,
                    isThreadChild: i > 0,
                    isThreadLastChild: i === uniqueSliceItems.length - 1 && i > 0,
                    isIncompleteThread: slice.isIncompleteThread,
                    sliceReason: slice.reason,
                    nestingDepth: 0,
                    truncatedChildCount: 0,
                    threadRootId,
                });
            }
        }
        return ensureUniqueFeedRows(spliceInterstitials(rows, interstitials));
    }

    // Fallback: wrap flat items into single-post FeedRows (no thread state)
    if (src.length === 0) return [];

    const deduped = deduplicateItems(src, getItemKey);
    const filteredByPrivacy = blockedSet.size > 0
        ? deduped.filter((item) => {
            const authorId = item.user?.id;
            return authorId ? !blockedSet.has(authorId) : true;
        })
        : deduped;

    // Threaded mode: build reply tree and flatten with nesting depth
    if (threaded && threadPostId && filteredByPrivacy.length > 0) {
        const tree = buildReplyTree(filteredByPrivacy, threadPostId);
        const rows: PostFeedRow[] = [];

        const flattenNode = (node: ReplyNode, depth: number) => {
            const item = node.reply;
            const isTruncated = depth >= MAX_THREAD_NESTING_DEPTH && node.children.length > 0;

            rows.push({
                kind: 'post',
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

        return ensureUniqueFeedRows(spliceInterstitials(rows, interstitials));
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
                const d = probe.date;
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

    const flatRows: PostFeedRow[] = finalItems.map((item) => ({
        kind: 'post',
        item,
        sliceKey: getItemKey(item),
        isThreadParent: false,
        isThreadChild: false,
        isThreadLastChild: false,
        isIncompleteThread: false,
        nestingDepth: 0,
        truncatedChildCount: 0,
    }));

    return ensureUniqueFeedRows(spliceInterstitials(flatRows, interstitials));
}

/** Stable key for a feed row (slice-scoped for posts, server-issued for cards). */
export function feedRowKey(row: FeedRow): string {
    if (row.kind === 'interstitial') return row.slot.key;
    const itemId = getItemKey(row.item);
    return row.sliceKey !== itemId ? `${row.sliceKey}:${itemId}` : itemId;
}

/**
 * Recycle/type bucket for a feed row. Used by FlashList recycling on native.
 * Each interstitial kind gets its own bucket, so a recommendation card can never
 * be recycled onto a post cell (nor onto a card of a different kind).
 */
export function feedRowType(row: FeedRow): string {
    if (row.kind === 'interstitial') return `interstitial:${row.slot.kind}`;
    if (row.nestingDepth > 0) return `nested_${row.nestingDepth}`;
    if (row.isThreadParent) return 'threadParent';
    if (row.isThreadChild) return 'threadChild';
    const item = row.item;
    if (item.boost) return 'boost';
    if (item.quotedPost) return 'quote';
    if (item.parentPostId) return 'reply';
    return 'post';
}

export interface RenderFeedRowDeps {
    router: ReturnType<typeof useRouter>;
    threadLineColor: string;
    /**
     * Descriptor of the feed this row belongs to. Threaded into `PostItem` so a
     * tap that opens the post detail reports a `click` interaction attributed to
     * the originating feed, and into `FeedInterstitial` so a recommendation card's
     * events are attributed to the feed it interrupted. Absent for non-feed
     * renders (e.g. embedded lists), which report nothing.
     */
    feedDescriptor?: string;
}

/**
 * The "Show this thread" affordance below an incomplete thread's last post.
 * It participates in the thread-wide hover unit: hovering it lights up every
 * post of the thread (and itself), and hovering any post lights it up too. Its
 * own subscription is scoped via a zustand selector so it only re-renders when
 * THIS slice's active state flips. A standalone component (not inline in
 * `renderFeedRow`, which is a plain function) so the hook is tracked by React.
 */
const ShowThreadLink: React.FC<{ sliceKey: string; onPress: () => void }> = ({ sliceKey, onPress }) => {
    const active = useThreadHoverStore((s) => s.hoveredSliceKey === sliceKey);
    const setHoveredSlice = useThreadHoverStore((s) => s.setHoveredSlice);
    return (
        <Pressable
            className="border-border"
            style={styles.showThreadLink}
            onPress={onPress}
            onHoverIn={() => setHoveredSlice(sliceKey)}
            onHoverOut={() => setHoveredSlice(null)}
        >
            <SubtleHover active={active} />
            <Text className="text-primary text-sm font-medium">
                Show this thread
            </Text>
        </Pressable>
    );
};

/**
 * Render a single feed row (PostItem + thread/slice affordances, or a
 * recommendation card). Shared by both platform Feed implementations so the row
 * markup never diverges.
 */
export function renderFeedRow(row: FeedRow, { router, threadLineColor, feedDescriptor }: RenderFeedRowDeps): React.ReactElement | null {
    if (row.kind === 'interstitial') {
        return (
            <FeedInterstitial
                slot={row.slot}
                ordinal={row.ordinal}
                feedDescriptor={feedDescriptor}
            />
        );
    }

    const post = row.item;
    if (!post || !post.id) {
        logger.warn('Invalid post item', { post });
        return null;
    }

    const showThreadLink = row.isIncompleteThread && row.isThreadLastChild;
    const showMoreReplies = row.isIncompleteThread && row.truncatedChildCount > 0;
    // In a `replyContext` slice the REPLY is always the LAST item — the parent,
    // when the server holds it, is prepended. `!isThreadParent` is exactly "last
    // item of the slice" for both shapes the server emits: the 2-item
    // [parent, reply] and the 1-item [reply] it falls back to when the parent is
    // unavailable (already on the page, unpublished, or — for a federated reply
    // whose `inReplyTo` never resolved — absent from the database).
    //
    // Keying on `isThreadChild` (index > 0) instead SKIPPED the 1-item shape, so
    // a context-free reply rendered as an ordinary top-level post.
    const isReplyContextRow = !row.isThreadParent && row.sliceReason?.type === 'replyContext';
    // Present only when the server could resolve whom the reply answers.
    const replyContextAuthor = !row.isThreadParent && row.sliceReason?.type === 'replyContext'
        ? row.sliceReason.parentAuthor
        : undefined;
    const nestPadding = row.nestingDepth > 0 ? { paddingLeft: 16 * row.nestingDepth } : undefined;

    // PURE repost (boost): render the ORIGINAL post directly (its author, content,
    // media, actions) with a "Reposted by X" context row on top — NOT the original
    // nested inside an empty boost shell. The post id, thread links, and error
    // boundary all target the ORIGINAL so engagement and tap-to-open hit it. Quote
    // posts carry `quotedPost` (not `boost`) and are untouched. If the boost's
    // original is missing (deleted), fall back to rendering the boost item as-is.
    const boostCtx = (post as { boost?: { originalPost?: HydratedPostSummary | null; actor?: PostUser } }).boost;
    const boostedOriginal = boostCtx?.originalPost;
    const renderedPost: FeedItem = boostedOriginal ?? post;
    const renderedPostId = renderedPost.id;

    const content = (
        <PostErrorBoundary postId={renderedPostId}>
            <PostItem
                post={renderedPost}
                isThreadParent={row.isThreadParent}
                isThreadChild={row.isThreadChild}
                isThreadLastChild={row.isThreadLastChild}
                attachedBelow={showThreadLink}
                nestingDepth={row.nestingDepth}
                isReplyContext={boostedOriginal ? false : isReplyContextRow}
                replyContextAuthor={boostedOriginal ? undefined : replyContextAuthor}
                repostedBy={boostedOriginal ? boostCtx?.actor : undefined}
                feedDescriptor={feedDescriptor}
                sliceKey={row.sliceKey}
                threadRootId={row.threadRootId}
                isThread={Boolean(row.threadRootId)}
            />
            {showThreadLink && (
                <ShowThreadLink
                    sliceKey={row.sliceKey}
                    onPress={() => router.push(`/p/${renderedPostId}`)}
                />
            )}
            {showMoreReplies && (
                <Pressable
                    style={[styles.showMoreReplies, nestPadding]}
                    onPress={() => router.push(`/p/${renderedPostId}`)}
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
                <View style={[styles.nestedThreadLine, { backgroundColor: threadLineColor }]} />
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
