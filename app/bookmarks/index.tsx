import React, { useState, useEffect } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator } from "react-native";
import { Stack } from "expo-router";
import { samplePosts } from "@/constants/sampleData";
import Post from "@/components/Post";
import { Header } from "@/components/Header";
import { useFetchPosts } from "@/hooks/useFetchPosts";

export default function BookmarksScreen() {
    const posts = useFetchPosts();
    const [loading, setLoading] = useState(true);

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
                    data={posts} // Replace with actual bookmarked posts data
                    renderItem={({ item }) => (
                        <Post
                            id={item.id}
                            avatar={item.user.avatar}
                            name={item.user.name}
                            username={item.user.username}
                            content={item.content}
                            time={item.timestamp}
                            likes={item.likes}
                            reposts={item.reposts}
                            replies={item.replies}
                            images={item.images}
                            poll={item.poll}
                            location={item.location}
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
