import React from "react";
import { View, StyleSheet, FlatList, TouchableOpacity, Text, Platform } from "react-native";
import { Link } from "expo-router";
import { Pressable } from 'react-native-web-hover'
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/styles/colors";

export const TrendItem = ({
    topHeader,
    mainTitle,
    numberOfPosts,
}: {
    topHeader: string
    mainTitle: string
    numberOfPosts: string
}) => {
    return (
        <Link href={mainTitle as any} style={styles.trendItem}>
            <View
                style={{
                    flex: 1,
                    justifyContent: 'space-between',
                }}>
                <Text style={{ fontSize: 13, color: colors.COLOR_BLACK_LIGHT_4 }}>
                    {topHeader}
                </Text>
                <Text style={{ fontSize: 15, fontWeight: 'bold', paddingVertical: 3 }}>
                    {mainTitle}
                </Text>
                <Text style={{ fontSize: 14, color: colors.COLOR_BLACK_LIGHT_4 }}>
                    {numberOfPosts}
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