import React, { useState, useEffect, useContext, useCallback } from "react";
import { View, StyleSheet, VirtualizedList } from "react-native";
import { useSelector, useDispatch } from 'react-redux';
import { CreatePost } from "../CreatePost";
import { Loading } from "@/assets/icons/loading-icon";
import { createPost, fetchPosts } from "@/store/reducers/postsReducer";
import { Post as IPost } from "@/interfaces/Post";
import Post from "@/components/Post";
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { colors } from "@/styles/colors";

const POSTS_PER_PAGE = 10;

export default function Feed() {
    const dispatch = useDispatch();
    const posts = useSelector((state) => state.posts.posts);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    const loadPosts = useCallback(async () => {
        if (!isLoadingMore) {
            setIsLoadingMore(true);
            await dispatch(fetchPosts({ page, limit: POSTS_PER_PAGE }));
            setIsLoadingMore(false);
        }
    }, [dispatch, page, isLoadingMore]);

    useEffect(() => {
        loadPosts();
    }, [page]);

    useEffect(() => {
        if (Array.isArray(posts) && posts.length > 0) {
            setLoading(false);
        }
    }, [posts]);

    const handleEndReached = () => {
        if (!isLoadingMore) {
            setPage(prev => prev + 1);
        }
    };

    const getItem = (data: IPost[], index: number) => data[index];
    const getItemCount = (data: IPost[]) => data.length;
    const keyExtractor = (item: IPost) => item.id;

    const renderItem = useCallback(({ item, index }: { item: IPost, index: number }) => {
        const isLastItem = index === posts.length - 1;
        return (
            <Post 
                postData={item} 
                style={isLastItem ? styles.lastItem : undefined}
                shouldLoadMedia={index < 5} // Only preload media for first 5 visible posts
            />
        );
    }, [posts.length]);

    const handleOpenCreatePostModal = () => {
        setBottomSheetContent(<CreatePost />);
        openBottomSheet(true);
    };

    return (
        <View style={styles.container}>
            <CreatePost style={styles.createPost} onPress={handleOpenCreatePostModal} />
            {loading ? (
                <Loading size={40} />
            ) : (
                <VirtualizedList
                    data={posts}
                    renderItem={renderItem}
                    getItem={getItem}
                    getItemCount={getItemCount}
                    keyExtractor={keyExtractor}
                    onEndReached={handleEndReached}
                    onEndReachedThreshold={0.5}
                    maxToRenderPerBatch={5}
                    windowSize={5}
                    initialNumToRender={5}
                    style={styles.flatListStyle}
                    ListFooterComponent={isLoadingMore ? <Loading size={20} /> : null}
                />
            )}
        </View>
    );
}

const postPaddingLeft = 62;

const styles = StyleSheet.create({
    container: {
        flexDirection: "column",
        flex: 1,
        borderRadius: 35,
        overflow: "hidden",
    },
    createPost: {
        marginBottom: 12,
    },
    flatListStyle: {
        flex: 1,
    },
    lastItem: {
        borderBottomRightRadius: 35,
        borderBottomLeftRadius: 35,
    },
});
