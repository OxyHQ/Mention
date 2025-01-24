import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView } from "react-native";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Stack } from "expo-router";
import { Header } from "@/components/Header";
import { colors } from "@/styles/colors";
import { ThemedView } from "@/components/ThemedView";
import Post from "@/components/Post";

const colorsArray = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];

const post = {
    id: "1",
    text: "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
    source: "web",
    in_reply_to_user_id: null,
    in_reply_to_username: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: {
        id: "1",
        username: "mention",
        name: {
            first: "Mention",
        },
        email: "hello@mention.earth",
        description: "A new social network for a new world.",
        color: "#000000",
    },
    media: [],
    quoted_post: null,
    is_quote_status: false,
    quoted_status_id: null,
    possibly_sensitive: false,
    lang: "en",
    _count: {
        likes: 0,
        reposts: 0,
        bookmarks: 0,
        replies: 0,
        quotes: 0,
    },
};

export default function AppearanceScreen() {
    const { t } = useTranslation();
    const colorScheme = useColorScheme();
    const [selectedColor, setSelectedColor] = useState(colorsArray[0]);

    return (
        <>
            <Stack.Screen options={{ title: t("Display") }} />
            <ScrollView>
                <Header options={{
                    leftComponents: [<Ionicons name="settings" size={24} color={colors.COLOR_BLACK} />],
                    title: t("Display"),
                    subtitle: t("These settings affect all the Mention accounts on this device."),
                    rightComponents: [<Ionicons name="add" size={24} color={colors.COLOR_BLACK} onPress={() => toast('My first toast')} />],
                }} />
                <ThemedView style={styles.postContainer}>
                    <View style={styles.postContainerView}>
                        {post && <Post postData={post} showActions={false} />}
                    </View>
                </ThemedView>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Theme")}</Text>
                    <View style={styles.optionsContainer}>
                        <TouchableOpacity
                            style={[styles.option, colorScheme === "light" && styles.selectedOption]}
                            onPress={() => setSelectedColor("light")}
                        >
                            <Ionicons name="sunny-outline" size={24} color="#000" />
                            <Text style={styles.optionText}>{t("Light")}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.option, colorScheme === "dark" && styles.selectedOption]}
                            onPress={() => setSelectedColor("dark")}
                        >
                            <Ionicons name="moon-outline" size={24} color="#000" />
                            <Text style={styles.optionText}>{t("Dark")}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Accent Color")}</Text>
                    <View style={styles.optionsContainer}>
                        {colorsArray.map((color) => (
                            <TouchableOpacity
                                key={color}
                                style={[styles.colorOption, { backgroundColor: color }, selectedColor === color && styles.selectedColorOption]}
                                onPress={() => setSelectedColor(color)}
                            />
                        ))}
                    </View>
                </View>
            </ScrollView>
        </>
    );
}


const styles = StyleSheet.create({
    postContainer: {
        padding: 16,
    },
    postContainerView: {
        backgroundColor: colors.primaryLight,
        borderRadius: 35,
    },
    section: {
        padding: 16,
        backgroundColor: "#fff",
        marginTop: 16,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: "bold",
        color: "#000",
        marginBottom: 8,
    },
    optionsContainer: {
        flexDirection: "row",
        flexWrap: "wrap",
    },
    option: {
        flexDirection: "row",
        alignItems: "center",
        padding: 12,
        borderRadius: 8,
        backgroundColor: "#f1f1f1",
        marginRight: 8,
        marginBottom: 8,
    },
    selectedOption: {
        backgroundColor: "#ddd",
    },
    optionText: {
        marginLeft: 8,
        fontSize: 16,
        color: "#000",
    },
    colorOption: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 8,
        marginBottom: 8,
    },
    selectedColorOption: {
        borderWidth: 2,
        borderColor: "#000",
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 16,
    },
});
