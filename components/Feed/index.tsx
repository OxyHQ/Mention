import React, { useState, useEffect, useContext, useCallback, useRef } from "react";
import { View, Text } from "react-native";
import { useSelector, useDispatch } from 'react-redux';
import { io } from "socket.io-client";
import { CreatePost } from "../CreatePost";
import { Loading } from "@/assets/icons/loading-icon";
import { createPost, fetchPosts, addPost } from "@/store/reducers/postsReducer";
import { Post as IPost } from "@/interfaces/Post";
import Post from "@/components/Post";
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { FlatList } from "react-native-gesture-handler";
import { RootState, AppDispatch } from '@/store/store';
import useAuth from "@/hooks/useAuth";

export default function Feed() {
    const dispatch = useDispatch<AppDispatch>();
    const posts = useSelector((state: RootState) => state.posts.posts);
    const [loading, setLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const { token: accessToken } = useAuth();
    const socketRef = useRef<any>(null);
    const initialLoadDone = useRef(false);

    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    useEffect(() => {
        if (!accessToken || socketRef.current) return;

        socketRef.current = io('/api/posts', {
            auth: { token: accessToken },
            transports: ['websocket'],
            reconnectionAttempts: 5
        });

        socketRef.current.on('connect', () => {
            console.log('Connected to posts namespace');
        });

        socketRef.current.on('connect_error', (error: Error) => {
            console.error('Socket connection error:', error.message);
            setError('Failed to connect to server');
        });

        socketRef.current.on('newPost', (newPost: IPost) => {
            dispatch(addPost(newPost));
        });

        return () => {
            if (socketRef.current) {
                socketRef.current.disconnect();
                socketRef.current = null;
            }
        };
    }, [accessToken, dispatch]);

    const loadPosts = useCallback(async () => {
        if (isLoadingMore || !hasMore) return;

        try {
            setIsLoadingMore(true);
            setError(null);
            const result = await dispatch(fetchPosts()).unwrap();
            // Assuming the API returns an empty array or fewer items when there are no more posts
            if (!result || result.length === 0) {
                setHasMore(false);
            }
        } catch (err) {
            setError('Failed to load posts');
            console.error('Error loading posts:', err);
        } finally {
            setIsLoadingMore(false);
            initialLoadDone.current = true;
        }
    }, [dispatch, isLoadingMore, hasMore]);

    useEffect(() => {
        if (!initialLoadDone.current) {
            loadPosts();
        }
        return () => setLoading(false);
    }, [loadPosts]);

    useEffect(() => {
        if (initialLoadDone.current) {
            setLoading(false);
        }
    }, [posts]);

    const handleEndReached = () => {
        if (!isLoadingMore && hasMore) {
            loadPosts();
        }
    };

    const renderItem = useCallback(({ item, index }: { item: IPost, index: number }) => {
        const isLastItem = index === posts.length - 1;
        return (
            <Post
                postData={item}
                className={isLastItem ? "rounded-bl-[35px] rounded-br-[35px]" : ""}
            />
        );
    }, [posts.length]);

    const handleOpenCreatePostModal = () => {
        setBottomSheetContent(<CreatePost />);
        openBottomSheet(true);
    };

    return (
        <View className="flex flex-col flex-1 rounded-[35px] overflow-hidden">
            <CreatePost onPress={handleOpenCreatePostModal} />
            {loading ? (
                <Loading size={40} />
            ) : error ? (
                <View className="flex-1 justify-center items-center">
                    <Text className="text-red-500 text-base">{error}</Text>
                </View>
            ) : (
                <FlatList
                    data={posts}
                    renderItem={renderItem}
                    keyExtractor={(item: IPost) => item.id}
                    onEndReached={handleEndReached}
                    onEndReachedThreshold={0.5}
                    maxToRenderPerBatch={10}
                    windowSize={7}
                    initialNumToRender={7}
                    removeClippedSubviews={true}
                    className="flex-1"
                    ListFooterComponent={isLoadingMore ? <Loading size={20} /> : null}
                />
            )}
        </View>
    );
}
