import React, { useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import PostItem from './PostItem';
import { PostErrorBoundary } from './PostErrorBoundary';
import { useTranslation } from 'react-i18next';
import { buildReplyTree, ReplyNode } from '@/utils/feedUtils';

const MAX_NESTING_DEPTH = 3;

interface ThreadedRepliesProps {
    replies: any[];
    postId: string;
    onReply?: () => void;
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
                    className="px-4 py-2.5"
                    style={{ paddingLeft: 16 * (depth + 1) }}
                    onPress={handleShowMore}
                    activeOpacity={0.7}
                >
                    <Text className="text-primary text-sm font-medium">
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
});

export default React.memo(ThreadedReplies);
