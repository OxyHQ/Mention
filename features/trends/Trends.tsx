import React, { useEffect } from "react";
import { View, StyleSheet, FlatList, TouchableOpacity, Text, Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Pressable } from 'react-native-web-hover'
import { useTranslation } from "react-i18next";
import { useSelector, useDispatch } from 'react-redux';
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/styles/colors";
import { TrendItem } from "@/features/trends/TrendItem";
import { fetchTrends } from '@/store/reducers/trendsReducer';
import { Loading } from "@/assets/icons/loading-icon";

export const Trends = ({
    hideTrends
}: {
    hideTrends?: boolean
}) => {
    const router = useRouter();
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';
    const { t } = useTranslation();
    const trendsData = useSelector((state) => state.trends.trends);
    const isLoading = useSelector((state) => state.trends.isLoading); // Add loading state

    const dispatch = useDispatch();

    useEffect(() => {
        dispatch(fetchTrends());
    }, [dispatch]);

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
        <View
            style={{
                backgroundColor: isExplorePage ? "" : colors.primaryLight,
                borderRadius: isExplorePage ? 0 : 15,
                overflow: 'hidden',
            }}>
            <View
                style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingHorizontal: 14,
                    paddingVertical: 14,
                    borderBottomWidth: 0.01,
                    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
                }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold' }}>
                    {t("Trends for you")}
                </Text>
                <Ionicons style={{ fontSize: 20 }} name="settings" />
            </View>
            <View>
                <FlatList
                    data={trendsData}
                    renderItem={({ item, index }) => (
                        <TrendItem
                            topHeader="Hashtag · Trending"
                            mainTitle={item.text}
                            numberOfPosts={item.score}
                        />
                    )}
                    keyExtractor={(item) => item.id}
                />
            </View>
            {!isExplorePage && (
                <View>
                    <Pressable
                        onPress={() => { router.push('/explore') }}
                        style={({ hovered }) => [
                            hovered
                                ? {
                                    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
                                }
                                : {},
                            {
                                padding: 14,
                                ...Platform.select({
                                    web: {
                                        cursor: 'pointer',
                                    },
                                }),
                            },
                        ]}>
                        <Text style={{ fontSize: 15, color: colors.primaryColor }}>
                            {t("Show more")}
                        </Text>
                    </Pressable>
                </View>
            )}
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
