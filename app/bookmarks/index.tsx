import React, { useState, useEffect } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator } from "react-native";
import Post from "@/components/Post";
import { Header } from "@/components/Header";
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';

export default function BookmarksScreen() {
    const posts = useSelector((state) => state.posts.posts);
    const dispatch = useDispatch();
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        dispatch(fetchPosts());
    }, [dispatch]);

    useEffect(() => {
        if (posts.length > 0) {
            setLoading(false);
        }
    }, [posts]);

    return (
        <>
            <Header options={{
                title: "Bookmarks",
            }} />
            {loading ? (
                <ActivityIndicator size="large" color="#1DA1F2" />
            ) : (
                <FlatList
                    data={posts}
                    renderItem={({ item }) => (
                        <Post
                            postData={item}
                        />
                    )}
                    keyExtractor={(item) => item.id.toString()}
                />
            )}
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 16,
    },
});
