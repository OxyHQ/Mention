import React from "react";
import { View, Text, StyleSheet } from "react-native";

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
    },
    text: {
        fontSize: 14,
        color: "#333",
    },
});
