import React from "react";
import { View, StyleSheet, FlatList } from "react-native";
import { Link } from "expo-router";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { useFetchTrends } from "@/hooks/useFetchTrends";
import { Trend } from "@/interfaces/Trend";

const TrendItem = ({ trend, href, index }: { trend: Trend; href: string; index: number }) => (
    <Link href={href as any} style={styles.trendContainer}>
        <View style={styles.trendRankContainer}>
            <ThemedText style={styles.trendRank}>{index + 1}</ThemedText>
        </View>
        <View style={styles.trendContent}>
            <ThemedText style={styles.trendTopic}>{trend.topic}</ThemedText>
            <ThemedText style={styles.trendcountTotal}>
                {trend.countTotal.toLocaleString()} Posts
            </ThemedText>
        </View>
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
            ListHeaderComponent={<ThemedText style={styles.trendsHeader}>
                {t("Trends for you")}
            </ThemedText>}
            style={styles.trendsList}
        />
    );
}

const styles = StyleSheet.create({
    trendsHeader: {
        fontSize: 24,
        fontWeight: "bold",
        backgroundColor: "#f5f8fa",
        borderBottomWidth: 1,
        borderBottomColor: "#e1e8ed",
    },
    trendsList: {
        backgroundColor: "#ffffff",
    },
    trendContainer: {
        flexDirection: "row",
        padding: 10,
        borderBottomWidth: 1,
        borderBottomColor: "#e1e8ed",
    },
    trendRankContainer: {
        justifyContent: "center",
        alignItems: "center",
        width: 40,
    },
    trendRank: {
        fontWeight: "bold",
        color: "#1DA1F2",
        fontSize: 18,
    },
    trendContent: {
        flex: 1,
        paddingLeft: 10,
    },
    trendTopic: {
        fontWeight: "bold",
        fontSize: 18,
        color: "#14171a",
    },
    trendcountTotal: {
        color: "#657786",
        fontSize: 14,
    },
});