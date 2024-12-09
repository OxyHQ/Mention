import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Stack } from "expo-router";

const colors = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];

export default function AppearanceScreen() {
    const { t } = useTranslation();
    const colorScheme = useColorScheme();
    const [selectedColor, setSelectedColor] = useState(colors[0]);

    return (
        <>
            <Stack.Screen options={{ title: t("Appearance") }} />
            <ScrollView style={styles.container}>
                <View style={styles.headerContainer}>
                    <Text style={styles.headerTitle}>{t("Appearance")}</Text>
                    <Text style={styles.headerSubtitle}>{t("Customize the look and feel of the app")}</Text>
                </View>
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
                        {colors.map((color) => (
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
    container: {
        backgroundColor: "#f1f1f1",
    },
    headerContainer: {
        padding: 16,
        backgroundColor: "#fff",
        borderBottomWidth: 1,
        borderBottomColor: "#ddd",
    },
    headerTitle: {
        fontSize: 24,
        fontWeight: "bold",
        color: "#000",
    },
    headerSubtitle: {
        fontSize: 16,
        color: "#666",
        marginTop: 4,
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
});
