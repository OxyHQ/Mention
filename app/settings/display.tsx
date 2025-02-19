import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView } from "react-native";
import Slider from '@react-native-community/slider';
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Stack } from "expo-router";
import { Header } from "@/components/Header";
import { colors } from "@/styles/colors";
import { ThemedView } from "@/components/ThemedView";
import Post from "@/components/Post";
import { toast } from 'sonner';

const colorsArray = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 16;
const FONT_SIZE_STEPS = 5;
const FONT_SIZE_VALUES = Array.from({ length: FONT_SIZE_STEPS }, (_, i) => 
    MIN_FONT_SIZE + (i * ((MAX_FONT_SIZE - MIN_FONT_SIZE) / (FONT_SIZE_STEPS - 1)))
);

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
            last: ""
        },
        email: "hello@mention.earth",
        description: "A new social network for a new world.",
        color: "#000000",
        avatar: "https://mention.earth/default-avatar.png",
        image: "https://mention.earth/default-image.png"
    },
    media: [],
    quoted_post: null,
    is_quote_status: false,
    quoted_status_id: null,
    quoted_post_id: null,
    in_reply_to_status_id: null,
    userID: "1",
    possibly_sensitive: false,
    lang: "en",
    _count: {
        likes: 0,
        reposts: 0,
        bookmarks: 0,
        replies: 0,
        quotes: 0,
        comments: 0
    },
};

export default function AppearanceScreen() {
    const { t } = useTranslation();
    const colorScheme = useColorScheme();
    const [selectedColor, setSelectedColor] = useState(colorsArray[0]);
    const [selectedFontSize, setSelectedFontSize] = useState(DEFAULT_FONT_SIZE);

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
                    {post && <Post postData={post} showActions={false} className="rounded-3xl" />}
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
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Font Size")}</Text>
                    <View style={styles.sliderContainer}>
                        <Text style={styles.fontSizeLabel}>Aa</Text>
                        <View style={styles.sliderWrapper}>
                            <Slider
                                style={styles.slider}
                                minimumValue={MIN_FONT_SIZE}
                                maximumValue={MAX_FONT_SIZE}
                                step={(MAX_FONT_SIZE - MIN_FONT_SIZE) / (FONT_SIZE_STEPS - 1)}
                                value={selectedFontSize}
                                onValueChange={setSelectedFontSize}
                                minimumTrackTintColor={selectedColor}
                                maximumTrackTintColor="#CCCCCC"
                            />
                            <View style={styles.stepsContainer}>
                                {FONT_SIZE_VALUES.map((_, index) => (
                                    <View key={index} style={styles.step} />
                                ))}
                            </View>
                        </View>
                        <Text style={styles.fontSizeLabelLarge}>Aa</Text>
                    </View>
                    <Text style={styles.fontSizeValue}>{Math.round(selectedFontSize)}px</Text>
                </View>
            </ScrollView>
        </>
    );
}


const styles = StyleSheet.create({
    postContainer: {
        padding: 16,
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
        fontSize: 16, // Default font size
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
    sliderContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    sliderWrapper: {
        flex: 1,
        marginHorizontal: 10,
        height: 40,  // Reduced height
        position: 'relative',
    },
    slider: {
        width: '100%',
        height: 40,
        zIndex: 2,
    },
    stepsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        position: 'absolute',
        width: '100%',
        top: '50%',  // Center vertically
        zIndex: 1,
    },
    step: {
        width: 2,
        height: 8,
        backgroundColor: '#CCCCCC',
        transform: [{translateY: -4}],  // Center the step marker vertically
    },
    fontSizeLabel: {
        fontSize: 14,
        color: '#000',
    },
    fontSizeLabelLarge: {
        fontSize: 20,
        color: '#000',
    },
    fontSizeValue: {
        textAlign: 'center',
        marginTop: 8,
        color: '#666',
    },
});
