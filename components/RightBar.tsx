import React from 'react'
import { View, StyleSheet, Text, FlatList, Image, Platform, ViewStyle } from "react-native";
import { Link } from "expo-router";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from 'react-responsive'
import { colors } from '../styles/colors'
import { Ionicons } from '@expo/vector-icons'
import { SearchBar } from './SearchBar'
import { Pressable, ScrollView } from 'react-native-web-hover'
import { FollowButton } from '@/components/FollowButton'

import { useFetchTrends } from "@/hooks/useFetchTrends"

export function RightBar() {
    const isRightBarVisible = useMediaQuery({ minWidth: 990 })
    if (!isRightBarVisible) return null
    return (
        <View style={styles.container}>
            <SearchBar />
            <View style={
                {
                    paddingTop: 5,
                    width: '100%',
                    ...Platform.select({
                        web: {
                            position: 'sticky',
                            bottom: 0,
                        },
                    }),
                } as ViewStyle
            }>
                <Trends />
                <SuggestedFriends />
            </View>
        </View>
    )
}

function Trends() {
    const { t } = useTranslation();
    const trends = useFetchTrends();
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
                    data={trends}
                    renderItem={({ item, index }) => (
                        <TrendComponent
                            topHeader="Politics · Trending"
                            mainTitle={`#${item.topic}`}
                            numberOfPosts="40.8K posts"
                        />
                    )}
                    keyExtractor={(item) => item.id}
                />
            </View>
            <View>
                <Pressable
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

function SuggestedFriends() {
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
                <Text style={{ fontSize: 22, fontWeight: 'bold' }}>Who to follow</Text>
            </View>
            <View>
                {followRecData.map((data) => {
                    return <FollowRowComponent {...data} />
                })}
            </View>
            <View>
                <Pressable
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

const followRecData = [
    {
        photo:
            'https://pbs.twimg.com/profile_images/1360004712439767041/phm-6601_400x400.jpg',
        name: 'Nicolas',
        userName: '@necolas',
    },
    {
        name: 'Evan Bacon',
        photo:
            'https://pbs.twimg.com/profile_images/1308332115919020032/jlqFOD33_400x400.jpg',
        userName: '@Baconbrix',
    },
    {
        name: 'Dan',
        photo:
            'https://pbs.twimg.com/profile_images/1336281436685541376/fRSl8uJP_400x400.jpg',
        userName: '@dan_abramov',
    },
    {
        name: 'Krzysztof Magiera',
        photo:
            'https://pbs.twimg.com/profile_images/1064786289311010816/zD2FlyxR_400x400.jpg',
        userName: '@kzzzf',
    },
]
const FollowRowComponent = ({ name, userName, photo }: { name: string; userName: string; photo: string }) => {
    return (
        <Pressable
            style={({ hovered }) => [
                hovered
                    ? {
                        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
                    }
                    : {},
                {
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    borderBottomWidth: 0.01,
                    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
                    padding: 12,
                    ...Platform.select({
                        web: {
                            cursor: 'pointer',
                        },
                    }),
                },
            ]}>
            <Image
                style={{
                    width: 50,
                    height: 50,
                    borderRadius: 100,
                    backgroundColor: 'gray',
                }}
                source={{
                    uri: photo,
                }}
            />
            <View
                style={{
                    marginRight: 'auto',
                    marginLeft: 13,
                }}>
                <Text style={{ fontWeight: 'bold', fontSize: 15 }}>{name}</Text>
                <Text style={{ color: colors.COLOR_BLACK_LIGHT_4, paddingTop: 4 }}>
                    {userName}
                </Text>
            </View>
            <FollowButton />
        </Pressable>
    )
}
const TrendComponent = ({
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
