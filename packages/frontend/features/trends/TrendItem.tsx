import React from "react";
import { View, StyleSheet, TouchableOpacity, Text, Platform } from "react-native";
import { Link } from "expo-router";
import { Pressable } from 'react-native-web-hover'
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";

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
    const theme = useTheme();
    return (
        <Link href={`/search/%23${mainTitle}`} style={[styles.trendItem, { borderBottomColor: theme.colors.border }]}>
            <View
                style={{
                    flex: 1,
                    justifyContent: 'space-between',
                }}>
                <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                    {topHeader}
                </Text>
                <Text style={{ fontSize: 15, fontWeight: 'bold', paddingVertical: 3, color: theme.colors.text }}>
                    {`#${mainTitle}`}
                </Text>
                <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>
                    {numberOfPosts} {t("posts")}
                </Text>
            </View>
            <Pressable
                style={({ hovered }) => [
                    hovered
                        ? {
                            backgroundColor: theme.colors.backgroundSecondary,
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
                        color: theme.colors.textSecondary,
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
        ...Platform.select({
            web: {
                cursor: 'pointer',
            },
        }),
    },
})