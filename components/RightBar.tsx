import React, { useEffect, useState } from 'react'
import { View, StyleSheet, Text, Platform, TouchableOpacity, GestureResponderEvent, ActivityIndicator } from "react-native";
import { Link } from "expo-router";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from 'react-responsive'
import { colors } from '../styles/colors'
import { SearchBar } from './SearchBar'
import { FollowButton } from '@/modules/oxyhqservices/components/FollowButton'
import { useRouter, usePathname } from "expo-router";
import Avatar from '@/components/Avatar'
import { Trends } from "@/features/trends/Trends"
import type { OxyProfile } from '@/modules/oxyhqservices/types'
import { oxyClient } from '@/modules/oxyhqservices'

export function RightBar() {
    const isRightBarVisible = useMediaQuery({ minWidth: 990 });
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [recommendations, setRecommendations] = useState<OxyProfile[]>([]);

    useEffect(() => {
        const fetchRecommendations = async () => {
            try {
                setLoading(true);
                setError(null);
                const response = await oxyClient.getRecommendations(5); // Limit to 5 recommendations
                setRecommendations(response);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to fetch recommendations');
                console.error('Error fetching recommendations:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchRecommendations();
    }, []);

    if (!isRightBarVisible) return null;

    return (
        <View style={styles.container}>
            <SearchBar />
            {!isExplorePage && (<Trends />)}
            {loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color={colors.primaryColor} />
                    <Text style={styles.loadingText}>Loading recommendations...</Text>
                </View>
            ) : error ? (
                <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>Error: {error}</Text>
                </View>
            ) : recommendations?.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text>No recommendations available</Text>
                </View>
            ) : (
                <SuggestedFriends followRecData={recommendations} />
            )}
        </View>
    )
}

function SuggestedFriends({ followRecData }: { followRecData: Partial<OxyProfile>[] }) {
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
                    <FollowRowComponent key={data._id || index} profileData={data} />
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

const FollowRowComponent = ({ profileData }: { profileData: Partial<OxyProfile> }) => {
    const router = useRouter();
    const handleFollowClick = (e: GestureResponderEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    // Skip rendering if no _id (using _id instead of userID since that's what the API returns)
    if (!profileData._id) return null;

    const displayName = profileData.name?.first
        ? `${profileData.name.first} ${profileData.name.last || ''}`.trim()
        : profileData.username || 'Unknown User';

    const username = profileData.username || profileData._id;

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
                        {profileData.description && (
                            <Text
                                style={{
                                    color: colors.COLOR_BLACK_LIGHT_4,
                                    paddingTop: 4,
                                    fontSize: 13
                                }}
                                numberOfLines={2}
                            >
                                {profileData.description}
                            </Text>
                        )}
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
    loadingContainer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderRadius: 15,
        gap: 10,
    },
    loadingText: {
        color: colors.COLOR_BLACK_LIGHT_4,
    } as any,
    errorContainer: {
        padding: 20,
        backgroundColor: colors.primaryLight,
        borderRadius: 15,
    },
    errorText: {
        color: 'red',
    },
    emptyContainer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderRadius: 15,
    },
});
