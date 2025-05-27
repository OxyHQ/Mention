import Avatar from '@/components/Avatar';
import { Trends } from "@/features/trends/Trends";
import { FollowButton, Models, useOxy } from '@oxyhq/services/full';
import { Link, usePathname, useRouter } from "expo-router";
import React, { useEffect, useState } from 'react';
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useMediaQuery } from 'react-responsive';
import { colors } from '../styles/colors';
import { SearchBar } from './SearchBar';

export function RightBar() {
    const { oxyServices } = useOxy();
    const isRightBarVisible = useMediaQuery({ minWidth: 990 });
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [recommendations, setRecommendations] = useState<Models.User[] | null>(null);

    useEffect(() => {
        const fetchRecommendations = async () => {
            try {
                setLoading(true);
                setError(null);
                const response = await oxyServices.getProfileRecommendations();
                console.log('Recommendations:', response);
                setRecommendations(response);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to fetch recommendations');
                console.error('Error fetching recommendations:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchRecommendations();
    }, [oxyServices]);

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
                <SuggestedFriends followRecData={recommendations ?? []} />
            )}
        </View>
    )
}

function SuggestedFriends({ followRecData }: { followRecData: Models.User[] }) {
    const { t } = useTranslation();
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
                <Text style={{ fontSize: 18, fontWeight: 'bold' }}>
                    {t("Who to follow")}
                </Text>
            </View>
            <View>
                {followRecData?.map((data, index) => (
                    <FollowRowComponent key={data.id || index} profileData={data} />
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

const FollowRowComponent = ({ profileData }: { profileData: Models.User }) => {
    // Skip rendering if no id
    if (!profileData.id) return null;

    const displayName = profileData.name?.first
        ? `${profileData.name.first} ${profileData.name.last || ''}`.trim()
        : profileData.username || 'Unknown User';

    const username = profileData.username || profileData.id;

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
                    <Avatar id={profileData.id} />
                    <View style={{ marginRight: 'auto', marginLeft: 13 }}>
                        <Text style={{ fontWeight: 'bold', fontSize: 15 }}>
                            {displayName}
                        </Text>
                        <Text style={{ color: colors.COLOR_BLACK_LIGHT_4, paddingTop: 4 }}>
                            @{username}
                        </Text>
                        {profileData.bio && (
                            <Text
                                style={{
                                    color: colors.COLOR_BLACK_LIGHT_4,
                                    paddingTop: 4,
                                    fontSize: 13
                                }}
                                numberOfLines={2}
                            >
                                {profileData.bio}
                            </Text>
                        )}
                    </View>
                </View>
                <FollowButton
                    userId={profileData.id}
                    size="small"
                />
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
    followButton: {
        backgroundColor: colors.primaryColor,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    followButtonText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 14,
    },
});
