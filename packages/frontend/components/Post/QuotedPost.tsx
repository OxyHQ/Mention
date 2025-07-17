import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Post from ".";

interface QuotedPostProps {
    id?: string;
}

export default function QuotedPost({ id }: QuotedPostProps) {
    // Minimal implementation; expand as needed.
    if (!id) return null;
    return (
        <View style={styles.container}>
            <Text style={styles.text}>Quoted post: {id}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 8,
        borderColor: "#ccc",
        borderWidth: 1,
        borderRadius: 6,
        marginVertical: 8,
        width: '100%',
        flex: 1,
    },
    text: {
        fontSize: 14,
        color: "#333",
    },
});
