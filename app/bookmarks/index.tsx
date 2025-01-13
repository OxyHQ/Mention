import React from "react";
import { View, FlatList, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { samplePosts } from "@/constants/sampleData";
import Post from "@/components/Post";
import { Header } from "@/components/Header";

export default function BookmarksScreen() {
    return (
        <>
            <Header options={{
                title: "Bookmarks",
            }} />
            <FlatList
                data={samplePosts} // Replace with actual bookmarked posts data
                renderItem={({ item }) => (
                    <Post
                        id={item.id}
                        avatar={item.avatar}
                        name={item.name}
                        username={item.username}
                        content={item.content}
                        time={item.time}
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
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 16,
    },
});
