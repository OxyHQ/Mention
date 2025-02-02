import React, { useState, useEffect, useContext } from "react";
import { View, StyleSheet, FlatList, } from "react-native";
import { useSelector, useDispatch } from 'react-redux';
import { CreatePost } from "../CreatePost";
import { Loading } from "@/assets/icons/loading-icon";
import { createPost, fetchPosts } from "@/store/reducers/postsReducer";
import { Post as IPost } from "@/interfaces/Post";
import Post from "@/components/Post";
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { colors } from "@/styles/colors";

export default function Feed({ }) {
    const dispatch = useDispatch();
    const posts = useSelector((state) => state.posts.posts);
    const [loading, setLoading] = useState(true);

    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    useEffect(() => {
        dispatch(fetchPosts());
    }, [dispatch]);

    useEffect(() => {
        if (Array.isArray(posts) && posts.length > 0) {
            setLoading(false);
        }
    }, [posts]);

    const sortedPosts = React.useMemo(() => {
        return Array.isArray(posts) ? [...posts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) : [];
    }, [posts]);

    const renderItem = React.useCallback(({ item, index }: { item: IPost, index: number }) => {
        const isLastItem = index === sortedPosts.length - 1;
        return <Post postData={item} style={isLastItem ? styles.lastItem : undefined} />;
    }, [sortedPosts.length]);

    const handleOpenCreatePostModal = () => {
        setBottomSheetContent(<CreatePost />);
        openBottomSheet(true);
    };

    return (
        <View style={[styles.container]}>
            <CreatePost style={styles.createPost} onPress={handleOpenCreatePostModal} />
            {loading ? (
                <Loading size={40} />
            ) : (
                <FlatList<IPost>
                    data={sortedPosts}
                    renderItem={renderItem}
                    style={styles.flatListStyle}
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
});
