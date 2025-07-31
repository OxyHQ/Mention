import React from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    Image
} from 'react-native';
import PostItem from './PostItem';
import { UIPost, Reply, FeedRepost as Repost, FeedType, PostAction } from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import { router } from 'expo-router';
import { Share } from 'react-native';

interface FeedProps {
    data: UIPost[] | Reply[] | Repost[] | string[] | (UIPost | Reply | Repost)[];
    type: FeedType;
    onPostAction?: (action: PostAction, postId: string) => void;
    onMediaPress?: (imageUrl: string, index: number) => void;
    isLoading?: boolean;
}

const Feed: React.FC<FeedProps> = ({
    data,
    type,
    onPostAction,
    onMediaPress,
    isLoading = false
}) => {
    const { likePost, unlikePost, repost, likeReply, unlikeReply, addRepost, likeRepost, unlikeRepost } = usePostsStore();

    const handleShare = async (post: UIPost | Reply | Repost) => {
        try {
            const shareUrl = `https://mention.earth/post/${post.id}`;
            const shareMessage = 'content' in post && post.content
                ? `${post.user.name} (@${post.user.handle}): ${post.content}`
                : `${post.user.name} (@${post.user.handle}) reposted`;

            await Share.share({
                message: `${shareMessage}\n\n${shareUrl}`,
                url: shareUrl,
                title: `${post.user.name} on Mention`
            });
        } catch (error) {
            console.error('Error sharing post:', error);
        }
    };
    const renderMediaGrid = (images: string[]) => {
        const rows = [];
        for (let i = 0; i < images.length; i += 3) {
            const rowImages = images.slice(i, i + 3);
            rows.push(
                <View key={i} style={styles.mediaRow}>
                    {rowImages.map((imageUrl, index) => (
                        <TouchableOpacity
                            key={i + index}
                            style={styles.mediaImageContainer}
                            onPress={() => onMediaPress?.(imageUrl, i + index)}
                        >
                            <Image source={{ uri: imageUrl }} style={styles.mediaImage} />
                        </TouchableOpacity>
                    ))}
                </View>
            );
        }
        return <View style={styles.mediaGrid}>{rows}</View>;
    };

    const renderPost = (post: UIPost) => (
        <PostItem
            key={post.id}
            post={post}
            onReply={() => {
                router.push(`/reply?postId=${post.id}`);
                onPostAction?.('reply', post.id);
            }}
            onRepost={() => {
                router.push(`/repost?postId=${post.id}`);
                onPostAction?.('repost', post.id);
            }}
            onLike={() => {
                likePost(post.id);
                onPostAction?.('like', post.id);
            }}
            onShare={() => {
                handleShare(post);
                onPostAction?.('share', post.id);
            }}
        />
    );



    const renderContent = () => {
        if (isLoading) {
            return (
                <View style={styles.emptyTabView}>
                    <Text style={styles.emptyText}>Loading...</Text>
                </View>
            );
        }

        if (!data || data.length === 0) {
            return (
                <View style={styles.emptyTabView}>
                    <Text style={styles.emptyText}>
                        {type === 'posts' && 'No posts yet'}
                        {type === 'replies' && 'No replies yet'}
                        {type === 'media' && 'No media yet'}
                        {type === 'likes' && 'No likes yet'}
                        {type === 'reposts' && 'No reposts yet'}
                        {type === 'mixed' && 'No content yet'}
                    </Text>
                    <Text style={styles.emptySubtext}>
                        {type === 'posts' && 'When you post something, it will show up here'}
                        {type === 'replies' && 'When you reply to posts, they will show up here'}
                        {type === 'media' && 'When you post media, it will show up here'}
                        {type === 'likes' && 'When you like posts, they will show up here'}
                        {type === 'reposts' && 'When you repost something, it will show up here'}
                        {type === 'mixed' && 'Start posting to see content in your feed'}
                    </Text>
                </View>
            );
        }

        if (type === 'media') {
            return renderMediaGrid(data as string[]);
        }

        if (type === 'replies') {
            return (
                <View>
                    {(data as Reply[]).map((reply) => (
                        <PostItem
                            key={reply.id}
                            post={reply}
                            onReply={() => {
                                router.push(`/reply?postId=${reply.postId}`);
                                onPostAction?.('reply', reply.postId);
                            }}
                            onRepost={() => {
                                // For replies, we repost the original post
                                router.push(`/repost?postId=${reply.postId}`);
                                onPostAction?.('repost', reply.postId);
                            }}
                            onLike={() => {
                                likeReply(reply.id);
                                onPostAction?.('like', reply.id);
                            }}
                            onShare={() => {
                                handleShare(reply);
                                onPostAction?.('share', reply.id);
                            }}
                        />
                    ))}
                </View>
            );
        }

        if (type === 'reposts') {
            return (
                <View>
                    {(data as Repost[]).map((repost) => (
                        <PostItem
                            key={repost.id}
                            post={repost}
                            onReply={() => {
                                router.push(`/reply?postId=${repost.originalPostId}`);
                                onPostAction?.('reply', repost.originalPostId);
                            }}
                            onRepost={() => {
                                router.push(`/repost?postId=${repost.originalPostId}`);
                                onPostAction?.('repost', repost.originalPostId);
                            }}
                            onLike={() => {
                                likeRepost(repost.id);
                                onPostAction?.('like', repost.id);
                            }}
                            onShare={() => {
                                handleShare(repost);
                                onPostAction?.('share', repost.id);
                            }}
                        />
                    ))}
                </View>
            );
        }

        if (type === 'mixed') {
            return (
                <View>
                    {(data as (UIPost | Reply | Repost)[]).map((item) => {
                        if ('originalPostId' in item) {
                            // This is a repost
                            return (
                                <PostItem
                                    key={item.id}
                                    post={item}
                                    onReply={() => {
                                        router.push(`/reply?postId=${item.originalPostId}`);
                                        onPostAction?.('reply', item.originalPostId);
                                    }}
                                    onRepost={() => {
                                        router.push(`/repost?postId=${item.originalPostId}`);
                                        onPostAction?.('repost', item.originalPostId);
                                    }}
                                    onLike={() => {
                                        likeRepost(item.id);
                                        onPostAction?.('like', item.id);
                                    }}
                                    onShare={() => {
                                        handleShare(item);
                                        onPostAction?.('share', item.id);
                                    }}
                                />
                            );
                        } else if ('postId' in item) {
                            // This is a reply
                            return (
                                <PostItem
                                    key={item.id}
                                    post={item}
                                    onReply={() => {
                                        router.push(`/reply?postId=${item.postId}`);
                                        onPostAction?.('reply', item.postId);
                                    }}
                                    onRepost={() => {
                                        router.push(`/repost?postId=${item.postId}`);
                                        onPostAction?.('repost', item.postId);
                                    }}
                                    onLike={() => {
                                        likeReply(item.id);
                                        onPostAction?.('like', item.id);
                                    }}
                                    onShare={() => {
                                        handleShare(item);
                                        onPostAction?.('share', item.id);
                                    }}
                                />
                            );
                        } else {
                            // This is a post
                            return renderPost(item);
                        }
                    })}
                </View>
            );
        }

        return (
            <View>
                {(data as UIPost[]).map(renderPost)}
            </View>
        );
    };

    const getFeedTitle = () => {
        switch (type) {
            case 'posts': return 'Posts';
            case 'replies': return 'Replies';
            case 'media': return 'Media';
            case 'likes': return 'Likes';
            case 'reposts': return 'Reposts';
            case 'mixed': return 'For You';
            default: return 'Feed';
        }
    };

    return (
        <View style={styles.container}>
            {data && data.length > 0 && (
                <View style={styles.feedHeader}>
                    <Text style={styles.feedTitle}>{getFeedTitle()}</Text>
                    <Text style={styles.feedCount}>{data.length} items</Text>
                </View>
            )}
            {renderContent()}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#000',
    },
    feedHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
    },
    feedTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#FFF',
    },
    feedCount: {
        fontSize: 14,
        color: '#71767B',
    },
    emptyTabView: {
        height: 200,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyText: {
        color: '#71767B',
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 8,
    },
    emptySubtext: {
        color: '#536471',
        fontSize: 14,
        textAlign: 'center',
        paddingHorizontal: 32,
    },
    mediaGrid: {
        backgroundColor: '#000',
    },
    mediaRow: {
        flexDirection: 'row',
        marginBottom: 2,
    },
    mediaImageContainer: {
        flex: 1,
        marginHorizontal: 1,
    },
    mediaImage: {
        width: '100%',
        aspectRatio: 1,
        backgroundColor: '#2F3336',
    },
});

export default Feed; 