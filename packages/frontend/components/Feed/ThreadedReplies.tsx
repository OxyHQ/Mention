import React, { useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import PostItem from './PostItem';
import { PostErrorBoundary } from './PostErrorBoundary';
import { useTranslation } from 'react-i18next';

const MAX_NESTING_DEPTH = 3;

interface ReplyNode {
    reply: any;
    children: ReplyNode[];
}

interface ThreadedRepliesProps {
    replies: any[];
    postId: string;
    onReply?: () => void;
}

/**
 * Build a tree of replies from a flat list.
 * Top-level replies have parentPostId === postId.
 * Nested replies have parentPostId pointing to another reply.
 */
function buildReplyTree(replies: any[], postId: string): ReplyNode[] {
    const replyMap = new Map<string, ReplyNode>();
    const topLevel: ReplyNode[] = [];

    // Create nodes for all replies
    for (const reply of replies) {
        const id = String(reply.id || reply._id);
        replyMap.set(id, { reply, children: [] });
    }

    // Build tree
    for (const reply of replies) {
        const id = String(reply.id || reply._id);
        const parentId = String(reply.parentPostId || '');
        const node = replyMap.get(id)!;

        if (parentId === postId || !replyMap.has(parentId)) {
            // Top-level reply to the post, or parent not in this set
            topLevel.push(node);
        } else {
            // Nested reply - add to parent's children
            const parentNode = replyMap.get(parentId);
            if (parentNode) {
                parentNode.children.push(node);
            } else {
                topLevel.push(node);
            }
        }
    }

    return topLevel;
}

const ThreadedReplyNode: React.FC<{
    node: ReplyNode;
    depth: number;
    onReply?: () => void;
}> = ({ node, depth, onReply }) => {
    const { t } = useTranslation();
    const router = useRouter();

    const handleShowMore = useCallback(() => {
        const replyId = String(node.reply.id || node.reply._id);
        router.push(`/p/${replyId}`);
    }, [node.reply, router]);

    const shouldTruncate = depth >= MAX_NESTING_DEPTH && node.children.length > 0;

    return (
        <View style={depth > 0 ? styles.nestedContainer : undefined}>
            {depth > 0 && (
                <View className="bg-border" style={styles.threadLine} />
            )}
            <View style={depth > 0 ? { paddingLeft: 16 } : undefined}>
                <PostErrorBoundary postId={node.reply.id || node.reply._id}>
                    <PostItem post={node.reply} onReply={onReply} />
                </PostErrorBoundary>
            </View>

            {shouldTruncate ? (
                <TouchableOpacity
                    style={[styles.showMoreButton, { paddingLeft: 16 * (depth + 1) }]}
                    onPress={handleShowMore}
                    activeOpacity={0.7}
                >
                    <Text className="text-primary" style={styles.showMoreText}>
                        {t('Show more replies', { defaultValue: 'Show more replies' })} ({node.children.length})
                    </Text>
                </TouchableOpacity>
            ) : (
                node.children.map((child) => (
                    <ThreadedReplyNode
                        key={String(child.reply.id || child.reply._id)}
                        node={child}
                        depth={depth + 1}
                        onReply={onReply}
                    />
                ))
            )}
        </View>
    );
};

const ThreadedReplies: React.FC<ThreadedRepliesProps> = ({ replies, postId, onReply }) => {
    const tree = useMemo(() => buildReplyTree(replies, postId), [replies, postId]);

    if (tree.length === 0) return null;

    return (
        <View>
            {tree.map((node) => (
                <ThreadedReplyNode
                    key={String(node.reply.id || node.reply._id)}
                    node={node}
                    depth={0}
                    onReply={onReply}
                />
            ))}
        </View>
    );
};

const styles = StyleSheet.create({
    nestedContainer: {
        position: 'relative',
    },
    threadLine: {
        position: 'absolute',
        left: 32,
        top: 0,
        bottom: 0,
        width: 2,
        borderRadius: 1,
    },
    showMoreButton: {
        paddingVertical: 10,
        paddingHorizontal: 16,
    },
    showMoreText: {
        fontSize: 14,
        fontWeight: '500',
    },
});

export default React.memo(ThreadedReplies);
