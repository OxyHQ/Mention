import React from "react";
import { View, StyleSheet, FlatList, TouchableOpacity, Text, Platform } from "react-native";
import { useRouter } from "expo-router";
import { Pressable } from 'react-native-web-hover'
import { useTranslation } from "react-i18next";
import { useFetchTrends } from "@/hooks/useFetchTrends";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/styles/colors";
import { TrendItem } from "@/features/trends/TrendItem";

export const Trends = ({
}: {
    }) => {
    const router = useRouter();
    const { t } = useTranslation();
    const trendsData = useFetchTrends();

    return (
        <View
            style={{
                backgroundColor: colors.primaryLight,
                borderRadius: 15,
                marginVertical: 10,
                overflow: 'hidden',
            }}>
            <View
                style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingHorizontal: 15,
                    paddingVertical: 15,
                    borderBottomWidth: 0.01,
                    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
                }}>
                <Text style={{ fontSize: 20, fontWeight: 'bold' }}>Trends for you</Text>
                <Ionicons style={{ fontSize: 20 }} name="settings" />
            </View>
            <View>
                <FlatList
                    data={trendsData}
                    renderItem={({ item, index }) => (
                        <TrendItem
                            topHeader="Politics · Trending"
                            mainTitle={item.topic}
                            numberOfPosts="40.8K posts"
                        />
                    )}
                    keyExtractor={(item) => item.id}
                />
            </View>
            <View>
                <Pressable
                    onPress={() => { router.push('/trends') }}
                    style={({ hovered }) => [
                        hovered
                            ? {
                                backgroundColor: colors.COLOR_BLACK_LIGHT_6,
                            }
                            : {},
                        {
                            paddingVertical: 20,
                            paddingHorizontal: 14,
                            ...Platform.select({
                                web: {
                                    cursor: 'pointer',
                                },
                            }),
                        },
                    ]}>
                    <Text style={{ fontSize: 15, color: colors.primaryColor }}>
                        Show more
                    </Text>
                </Pressable>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        width: 350,
        alignItems: 'flex-start',
        // marginTop: 30,
        paddingStart: 20,
    },
    trendItem: {
        display: 'flex',
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 12,
        borderBottomWidth: 0.01,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        ...Platform.select({
            web: {
                cursor: 'pointer',
            },
        }),
    },
})
