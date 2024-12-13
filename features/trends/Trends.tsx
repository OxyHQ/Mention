import React from "react";
import { View, StyleSheet, FlatList, TouchableOpacity } from "react-native";
import { Link } from "expo-router";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { useFetchTrends } from "@/hooks/useFetchTrends";
import { Trend } from "@/interfaces/Trend";
import { Ionicons } from "@expo/vector-icons";

const TrendItem = ({ trend, href, index }: { trend: Trend; href: string; index: number }) => (
    <Link href={href as any} style={styles.trendContainer}>
        <View style={styles.trendContent}>
            <ThemedText style={styles.trendTopic}>#{trend.topic}</ThemedText>
            <ThemedText style={styles.trendCountTotal}>
                {trend.countTotal.toLocaleString()} Posts
            </ThemedText>
        </View>
        <TouchableOpacity style={styles.menuIcon}>
            <Ionicons name="ellipsis-horizontal" size={20} color="black" />
        </TouchableOpacity>
    </Link>
);

export function Trends() {
    const { t } = useTranslation();
    const trends = useFetchTrends();

    return (
        <FlatList
            data={trends}
            renderItem={({ item, index }) => (
                <TrendItem
                    trend={item}
                    href={`/explore?q=${item.topic}`}
                    index={index}
                />
            )}
            keyExtractor={(item) => item.id}
            style={styles.trendsList}
        />
    );
}

const styles = StyleSheet.create({
    trendsList: {
    },
    trendContainer: {
        flexDirection: "row",
        padding: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#e1e8ed",
        alignItems: "center",
    },
    trendContent: {
        flex: 1,
        paddingLeft: 5,
    },
    trendTopic: {
        fontWeight: "bold",
        fontSize: 16,
        color: "#14171a",
    },
    trendCountTotal: {
        color: "#657786",
        fontSize: 12,
    },
    menuIcon: {
        position: "absolute",
        right: 10,
        justifyContent: "center",
        alignItems: "center",
    },
});