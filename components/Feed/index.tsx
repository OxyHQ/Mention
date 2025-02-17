import React, { useState, useEffect, useContext, useCallback } from "react";
import { View, StyleSheet } from "react-native";
import { useSelector, useDispatch } from 'react-redux';
import { CreatePost } from "../CreatePost";
import { Loading } from "@/assets/icons/loading-icon";
import { createPost, fetchPosts } from "@/store/reducers/postsReducer";
import { Post as IPost } from "@/interfaces/Post";
import Post from "@/components/Post";
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { colors } from "@/styles/colors";
import { FlatList } from "react-native-gesture-handler";
import { RootState, AppDispatch } from '@/store/store';

export default function Feed() {
    const dispatch = useDispatch<AppDispatch>();
    const posts = useSelector((state: RootState) => state.posts.posts);
    const [loading, setLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    const loadPosts = useCallback(async () => {
        if (!isLoadingMore) {
            setIsLoadingMore(true);
            await dispatch(fetchPosts());
            setIsLoadingMore(false);
        }
    }, [dispatch, isLoadingMore]);

    useEffect(() => {
        loadPosts();
    }, [loadPosts]);

    useEffect(() => {
        if (Array.isArray(posts) && posts.length > 0) {
            setLoading(false);
        }
    }, [posts]);

    const handleEndReached = () => {
        if (!isLoadingMore) {
            loadPosts();
        }
    };

    const renderItem = useCallback(({ item, index }: { item: IPost, index: number }) => {
        const isLastItem = index === posts.length - 1;
        return (
            <Post 
                postData={item} 
                style={isLastItem ? styles.lastItem : undefined}
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
            <FlatList
                data={posts}
                renderItem={renderItem}
                keyExtractor={(item: IPost) => item.id}
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
