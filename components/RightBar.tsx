import React, { useEffect } from 'react'
import { View, StyleSheet, Text, Platform, ViewStyle } from "react-native";
import { Link } from "expo-router";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from 'react-responsive'
import { colors } from '../styles/colors'
import { Ionicons } from '@expo/vector-icons'
import { SearchBar } from './SearchBar'
import { Pressable } from 'react-native-web-hover'
import { FollowButton } from '@/components/FollowButton'
import { useRouter, usePathname } from "expo-router";
import Avatar from '@/components/Avatar'
import { useSelector, useDispatch } from 'react-redux'
import { fetchFollowRecommendations } from '@/store/reducers/followReducer'
import { Trends } from "@/features/trends/Trends"

// Define types for profile data
interface ProfileData {
    username: string;
    avatar: string;
    name: {
        first: string;
        last: string;
    };
}

export function RightBar() {
    const isRightBarVisible = useMediaQuery({ minWidth: 990 })
    const router = useRouter();
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';
    const dispatch = useDispatch();
    const followRecData = useSelector((state: { follow: { profiles: ProfileData[] } }) => state.follow.profiles);

    useEffect(() => {
        dispatch(fetchFollowRecommendations());
    }, [dispatch]);

    if (!isRightBarVisible) return null
    return (
        <View style={styles.container}>
            <SearchBar />
            {!isExplorePage && (<Trends />)}
            <SuggestedFriends followRecData={followRecData} />
        </View>
    )
}

function SuggestedFriends({ followRecData }: { followRecData: ProfileData[] }) {
    const router = useRouter();
    return (
        <View
            style={{
                backgroundColor: colors.primaryLight,
                borderRadius: 15,
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
                <Text style={{ fontSize: 18, fontWeight: 'bold' }}>Who to follow</Text>
            </View>
            <View>
                {followRecData.map((data, index) => (
                    <FollowRowComponent key={data.username || index} profileData={data} />
                ))}
            </View>
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
                        Show more
                    </Text>
                </Pressable>
            </View>
        </View>
    )
}

// Add prop types for FollowRowComponent
const FollowRowComponent = ({ profileData }: { profileData: ProfileData }) => {
    const router = useRouter();
    return (
        <Link href={`/@${profileData.username}`} asChild>
            <View
                style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    borderBottomWidth: 0.01,
                    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
                    padding: 12,
                    flex: 1,
                    ...Platform.select({
                        web: {
                            cursor: 'pointer',
                        },
                    }),
                }}>
                <Avatar id={profileData.avatar} />
                <View
                    style={{
                        marginRight: 'auto',
                        marginLeft: 13,
                    }}>
                    <Text style={{ fontWeight: 'bold', fontSize: 15 }}>
                        {profileData.name?.first
                            ? `${profileData.name.first} ${profileData.name.last}`
                            : profileData.username}
                    </Text>
                    <Text style={{ color: colors.COLOR_BLACK_LIGHT_4, paddingTop: 4 }}>
                        @{profileData.username}
                    </Text>
                </View>
                <FollowButton />
            </View>
        </Link>
    )
}

const styles = StyleSheet.create({
    container: {
        width: 350,
        paddingStart: 20,
        flexDirection: 'column',
        gap: 20,
        ...Platform.select({
            web: {
                position: 'sticky' as any,
                top: 50,
                bottom: 20,
            },
        }),
    },
});
