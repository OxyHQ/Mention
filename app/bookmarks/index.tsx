import React from "react";
import { View, FlatList, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { samplePosts } from "@/constants/sampleData";
import Post from "@/components/Post";
import { ThemedView } from "@/components/ThemedView";

export default function BookmarksScreen() {
    return (
        <>
            <Stack.Screen options={{ title: "Bookmarks" }} />
            <ThemedView style={styles.container}>
                <FlatList
                    data={samplePosts} // Replace with actual bookmarked posts data
                    renderItem={({ item }) => <Post {...item} />}
                    keyExtractor={(item) => item.id}
                />
            </ThemedView>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
    },
});