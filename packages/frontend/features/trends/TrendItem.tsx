import React from "react";
import { View, StyleSheet, TouchableOpacity, Text, Platform } from "react-native";
import { Link } from "expo-router";
import { Pressable } from 'react-native-web-hover'
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/styles/colors";
import { useTranslation } from "react-i18next";

export const TrendItem = ({
    topHeader,
    mainTitle,
    numberOfPosts,
}: {
    topHeader: string
    mainTitle: string
    numberOfPosts: number
}) => {
    const { t } = useTranslation();
    return (
        <Link href={`/search/%23${mainTitle}`} style={styles.trendItem}>
            <View
                style={{
                    flex: 1,
                    justifyContent: 'space-between',
                }}>
                <Text style={{ fontSize: 13, color: colors.COLOR_BLACK_LIGHT_4 }}>
                    {topHeader}
                </Text>
                <Text style={{ fontSize: 15, fontWeight: 'bold', paddingVertical: 3 }}>
                    {`#${mainTitle}`}
                </Text>
                <Text style={{ fontSize: 14, color: colors.COLOR_BLACK_LIGHT_4 }}>
                    {numberOfPosts} {t("posts")}
                </Text>
            </View>
            <Pressable
                style={({ hovered }) => [
                    hovered
                        ? {
                            backgroundColor: colors.COLOR_BLACK_LIGHT_6,
                        }
                        : {},
                    {
                        borderRadius: 100,
                        width: 40,
                        height: 40,
                        justifyContent: 'center',
                        alignItems: 'center',
                        marginTop: -20,
                    },
                ]}>
                <Ionicons
                    name="ellipsis-horizontal"
                    style={{
                        fontSize: 20,
                        color: colors.COLOR_BLACK_LIGHT_5,
                    }}
                />
            </Pressable>
        </Link>
    )
}

const styles = StyleSheet.create({

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