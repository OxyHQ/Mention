import React from 'react'
import { View, StyleSheet, Text, Platform, TouchableOpacity, ViewStyle, GestureResponderEvent } from "react-native";
import { Link } from "expo-router";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from 'react-responsive'
import { colors } from '../styles/colors'
import { SearchBar } from './SearchBar'
import { FollowButton } from '@/components/FollowButton'
import { useRouter, usePathname } from "expo-router";
import Avatar from '@/components/Avatar'
import { useSelector, useDispatch } from 'react-redux'
import { AppDispatch, RootState } from '@/store/store'
import { fetchFollowRecommendations } from '@/store/reducers/followReducer'
import { Trends } from "@/features/trends/Trends"

// Define types for profile data
interface ProfileData {
    _id: string;
    userID: string;
    username?: string;
    avatar?: string;
    name?: {
        first?: string;
        last?: string;
    };
}

export function RightBar() {
    const isRightBarVisible = useMediaQuery({ minWidth: 990 })
    const router = useRouter();
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';
    const dispatch = useDispatch<AppDispatch>();
    const followRecData = useSelector((state: RootState) => state.follow.profiles);

    React.useEffect(() => {
        dispatch(fetchFollowRecommendations());
    }, [dispatch]);

    if (!isRightBarVisible) return null;

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
    const { t } = useTranslation();
    
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
                <Text style={{ fontSize: 18, fontWeight: 'bold' }}>
                    {t("Who to follow")}
                </Text>
            </View>
            <View>
                {followRecData?.map((data, index) => (
                    <FollowRowComponent key={data.userID || index} profileData={data} />
                ))}
            </View>
            <TouchableOpacity
                onPress={() => router.push('/explore')}
                style={{
                    padding: 14,
                    backgroundColor: 'transparent',
                    ...Platform.select({
                        web: {
                            cursor: 'pointer',
                        },
                    }),
                }}
                activeOpacity={0.7}>
                <Text style={{ fontSize: 15, color: colors.primaryColor }}>
                    {t("Show more")}
                </Text>
            </TouchableOpacity>
        </View>
    );
}

const FollowRowComponent = ({ profileData }: { profileData: ProfileData }) => {
    const router = useRouter();
    const handleFollowClick = (e: GestureResponderEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const displayName = profileData.name?.first
        ? `${profileData.name.first} ${profileData.name.last || ''}`
        : profileData.username || 'Unknown User';

    const username = profileData.username || profileData.userID;

    return (
        <Link href={`/@${username}`} asChild>
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
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <Avatar id={profileData.avatar} />
                    <View style={{ marginRight: 'auto', marginLeft: 13 }}>
                        <Text style={{ fontWeight: 'bold', fontSize: 15 }}>
                            {displayName}
                        </Text>
                        <Text style={{ color: colors.COLOR_BLACK_LIGHT_4, paddingTop: 4 }}>
                            @{username}
                        </Text>
                    </View>
                </View>
                <TouchableOpacity onPress={handleFollowClick}>
                    <FollowButton userId={profileData._id} />
                </TouchableOpacity>
            </View>
        </Link>
    );
};

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
