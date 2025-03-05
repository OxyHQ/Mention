import React, { useState, useEffect, useContext, useCallback, useRef } from "react";
import { View, Text } from "react-native";
import { useSelector, useDispatch } from 'react-redux';
import { io, Socket } from "socket.io-client";
import { CreatePost } from "../CreatePost";
import { Loading } from "@/assets/icons/loading-icon";
import { Post as IPost } from "@/interfaces/Post";
import Post from "@/components/Post";
import { FlashList } from "@shopify/flash-list";
import { feedService, FeedType } from "@/services/feedService";
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { SOCKET_URL } from "@/config";
import { oxyClient } from '@/modules/oxyhqservices/services/OxyClient';
import type { OxyProfile } from '@/modules/oxyhqservices/types';

// Use the same profile cache across components
declare global {
    var profileCache: Map<string, OxyProfile>;
}

if (!global.profileCache) {
    global.profileCache = new Map<string, OxyProfile>();
}

interface FeedProps {
    type: FeedType;
    userId?: string;
    hashtag?: string;
    parentId?: string;
    showCreatePost?: boolean;
    className?: string;
}

export default function Feed({ type, userId, hashtag, parentId, showCreatePost = true, className }: FeedProps) {
    const [posts, setPosts] = useState<IPost[]>([]);
    const [loading, setLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const socket = useRef<Socket | null>(null);
    const session = useContext(SessionContext);
    const isInitialLoad = useRef(true);

    const initializeSocket = useCallback(() => {
        if (!session?.getCurrentUserId()) return;

        console.log('Initializing socket connection to:', `${SOCKET_URL}/api/posts`);

        socket.current = io(`${SOCKET_URL}/api/posts`, {
            query: {
                userId: session.getCurrentUserId(),
                feedType: type,
                ...(userId && { targetUserId: userId }),
                ...(hashtag && { hashtag }),
                ...(parentId && { parentId })
            }
        });

        socket.current.on('connect', () => {
            console.log('Socket connected successfully');
        });

        socket.current.on('connect_error', (error) => {
            console.error('Socket connection error:', error);
        });

        socket.current.on('newPost', async (data: { post: IPost }) => {
            console.log('Received new post:', data);
            try {
                if (data.post.author?.id) {
                    const profile = await oxyClient.getProfile(data.post.author.id);
                    data.post.author = {
                        ...data.post.author,
                        ...profile
                    };
                }
                setPosts(prevPosts => {
                    const exists = prevPosts.some(post => post.id === data.post.id);
                    if (!exists) {
                        return [data.post, ...prevPosts];
                    }
                    return prevPosts;
                });
            } catch (error) {
                console.error('Error fetching post author profile:', error);
            }
        });

        socket.current.on('postUpdate', async (data: { type: string; postId: string; userId: string; _count: any }) => {
            setPosts(prevPosts =>
                prevPosts.map(post => {
                    if (post.id === data.postId) {
                        const isCurrentUser = session?.getCurrentUserId() === data.userId;
                        let updatedPost = { ...post };

                        switch (data.type) {
                            case 'like':
                                if (isCurrentUser) updatedPost.isLiked = true;
                                updatedPost._count = { ...updatedPost._count || {}, ...data._count };
                                break;
                            case 'unlike':
                                if (isCurrentUser) updatedPost.isLiked = false;
                                updatedPost._count = { ...updatedPost._count || {}, ...data._count };
                                break;
                            case 'bookmark':
                                if (isCurrentUser) updatedPost.isBookmarked = true;
                                updatedPost._count = { ...updatedPost._count || {}, ...data._count };
                                break;
                            case 'unbookmark':
                                if (isCurrentUser) updatedPost.isBookmarked = false;
                                updatedPost._count = { ...updatedPost._count || {}, ...data._count };
                                break;
                            case 'repost':
                                if (isCurrentUser) updatedPost.isReposted = true;
                                updatedPost._count = { ...updatedPost._count || {}, ...data._count };
                                break;
                            case 'unrepost':
                                if (isCurrentUser) updatedPost.isReposted = false;
                                updatedPost._count = { ...updatedPost._count || {}, ...data._count };
                                break;
                        }

                        return updatedPost;
                    }
                    return post;
                })
            );
        });

        socket.current.on('postDelete', (deletedPostId: string) => {
            setPosts(prevPosts =>
                prevPosts.filter(post => post.id !== deletedPostId)
            );
        });

        return () => {
            console.log('Cleaning up socket connection');
            socket.current?.disconnect();
            socket.current = null;
        };
    }, [type, userId, hashtag, parentId, session]);

    const loadPosts = useCallback(async (isInitial: boolean = false) => {
        try {
            if (isInitial) {
                setLoading(true);
            } else {
                setIsLoadingMore(true);
            }

            setError(null);

            const response = await feedService.fetchFeed(type, {
                userId,
                hashtag,
                parentId,
                cursor: isInitial ? undefined : nextCursor || undefined
            });

            // Fetch and cache author profiles for each post
            const postsWithProfiles = await Promise.all(
                response.posts.map(async (post) => {
                    if (post.author?.id) {
                        try {
                            // Check cache first
                            let profile = global.profileCache.get(post.author.id);
                            
                            if (!profile) {
                                profile = await oxyClient.getProfile(post.author.id);
                                // Update cache
                                global.profileCache.set(post.author.id, profile);
                            }
                            
                            return {
                                ...post,
                                author: {
                                    ...post.author,
                                    ...profile
                                }
                            };
                        } catch (error) {
                            console.error('Error fetching post author profile:', error);
                            return post;
                        }
                    }
                    return post;
                })
            );

            setPosts(prevPosts =>
                isInitial ? postsWithProfiles : [...prevPosts, ...postsWithProfiles]
            );
            setNextCursor(response.nextCursor);
            setHasMore(response.hasMore);
        } catch (err) {
            console.error('Error loading posts:', err);
            setError(err instanceof Error ? err.message : 'Failed to load posts');
        } finally {
            if (isInitial) {
                setLoading(false);
            } else {
                setIsLoadingMore(false);
            }
        }
    }, [type, userId, hashtag, parentId, nextCursor]);

    useEffect(() => {
        if (isInitialLoad.current) {
            loadPosts(true);
            isInitialLoad.current = false;
        }
        const cleanup = initializeSocket();
        return () => {
            cleanup?.();
        };
    }, [type, userId, hashtag, parentId]);

    const handleRefresh = useCallback(() => {
        isInitialLoad.current = true;
        loadPosts(true);
    }, [loadPosts]);

    const handleLoadMore = useCallback(() => {
        if (!isLoadingMore && hasMore && !loading) {
            loadPosts(false);
        }
    }, [hasMore, isLoadingMore, loading, loadPosts]);

    return (
        <View className={`flex flex-col flex-1 rounded-[35px] overflow-hidden ${className}`}>
            {showCreatePost && <CreatePost />}
            {loading ? (
                <Loading size={40} />
            ) : error ? (
                <View className="flex-1 justify-center items-center">
                    <Text className="text-red-500 text-base">{error}</Text>
                </View>
            ) : (
                <FlashList
                    data={posts}
                    renderItem={({ item }) => <Post postData={item} />}
                    keyExtractor={(item: IPost) => item.id}
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.5}
                    onRefresh={handleRefresh}
                    refreshing={loading}
                    estimatedItemSize={200}
                    removeClippedSubviews={true}
                    className="flex-1"
                    ListFooterComponent={isLoadingMore ? <Loading size={20} /> : null}
                />
            )}
        </View>
    );
}
