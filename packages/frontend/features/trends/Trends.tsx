import React, { useEffect } from "react";
import { View, StyleSheet, TouchableOpacity, Text, Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/styles/colors";
import { TrendItem } from "@/features/trends/TrendItem";
import LegendList from '@/components/LegendList';
import { useTrendsStore } from '@/store/trendsStore';
import { Loading } from "@/assets/icons/loading-icon";

// Type definition for trend items
interface TrendData {
    id: string;
    text: string;
    score: number;
    [key: string]: any;
}

export const Trends = ({
    hideTrends
}: {
    hideTrends?: boolean
}) => {
    const router = useRouter();
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';
    const { t } = useTranslation();
    const { trends, isLoading, fetchTrends } = useTrendsStore();

    useEffect(() => {
        fetchTrends();
    }, [fetchTrends]);

    if (hideTrends) return null;

    if (isLoading) {
        return (
            <View
                style={{
                    backgroundColor: colors.primaryLight,
                    borderRadius: 15,
                    alignContent: 'center',
                    alignItems: 'center',
                    flexDirection: 'column',
                    height: 400,
                }}>
                <Loading size={40} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <LegendList
                data={trends}
                keyExtractor={(item: TrendData) => item.id}
                renderItem={({ item }: { item: TrendData }) => (
                    <TrendItem
                        topHeader="Hashtag  Trending"
                        mainTitle={item.text}
                        numberOfPosts={item.score}
                    />
                )}
                removeClippedSubviews={false}
                maxToRenderPerBatch={10}
                windowSize={10}
                initialNumToRender={10}
                recycleItems={true}
                maintainVisibleContentPosition={true}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        padding: 16,
        backgroundColor: colors.primaryLight,
        borderRadius: 15,
        margin: 8,
    },
});
