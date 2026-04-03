import React, { useState, useCallback } from 'react';
import { View, StyleSheet, Platform, RefreshControl, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import FontAwesome5 from '@expo/vector-icons/FontAwesome5';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Loading } from '@oxyhq/bloom/loading';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { useSafeBack } from '@/hooks/useSafeBack';

import { Header } from '@/components/Header';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { EmptyState } from '@/components/common/EmptyState';
import { Error as ErrorComponent } from '@/components/Error';
import { SuggestedUsers } from '@/components/suggestions/SuggestedUsers';
import SEO from '@/components/SEO';
import { pokeService, ReceivedPoke, SentPoke, SuggestedPoke } from '@/services/pokeService';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';

const SENT_PREVIEW_COUNT = 3;
const SUGGESTED_PREVIEW_COUNT = 5;

export default function PokesScreen() {
    const { user, isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const router = useRouter();
    const safeBack = useSafeBack();
    const { t } = useTranslation();
    const theme = useTheme();
    const [refreshing, setRefreshing] = useState(false);
    const [showAllSent, setShowAllSent] = useState(false);
    const [showAllSuggested, setShowAllSuggested] = useState(false);

    const {
        data: receivedData,
        isLoading: loadingReceived,
        error: errorReceived,
        refetch: refetchReceived,
    } = useQuery({
        queryKey: ['pokes', 'received'],
        queryFn: () => pokeService.getReceivedPokes(),
        enabled: isAuthenticated,
    });

    const {
        data: sentData,
        isLoading: loadingSent,
        refetch: refetchSent,
    } = useQuery({
        queryKey: ['pokes', 'sent'],
        queryFn: () => pokeService.getSentPokes(),
        enabled: isAuthenticated,
    });

    const {
        data: suggestedData,
        isLoading: loadingSuggested,
        refetch: refetchSuggested,
    } = useQuery({
        queryKey: ['pokes', 'suggested'],
        queryFn: () => pokeService.getSuggested(),
        enabled: isAuthenticated,
    });

    const pokeMutation = useMutation({
        mutationFn: (userId: string) => pokeService.poke(userId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['pokes'] });
            toast(t('poke.sent', { defaultValue: 'Poked!' }), { type: 'success' });
        },
        onError: () => {
            toast(t('poke.error', { defaultValue: 'Failed to poke' }), { type: 'error' });
        },
    });

    const unpokeMutation = useMutation({
        mutationFn: (userId: string) => pokeService.unpoke(userId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['pokes'] });
            toast(t('poke.undone', { defaultValue: 'Poke undone' }), { type: 'success' });
        },
        onError: () => {
            toast(t('poke.error', { defaultValue: 'Failed to undo poke' }), { type: 'error' });
        },
    });

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([refetchReceived(), refetchSent(), refetchSuggested()]);
        setRefreshing(false);
    }, [refetchReceived, refetchSent, refetchSuggested]);

    const navigateToProfile = useCallback((username: string) => {
        router.push(`/@${username}` as any);
    }, [router]);

    const receivedPokes = receivedData?.pokes ?? [];
    const sentPokes = sentData?.pokes ?? [];
    const suggestions = suggestedData?.suggestions ?? [];

    const visibleSent = showAllSent ? sentPokes : sentPokes.slice(0, SENT_PREVIEW_COUNT);
    const visibleSuggested = showAllSuggested ? suggestions : suggestions.slice(0, SUGGESTED_PREVIEW_COUNT);

    const isLoading = loadingReceived && loadingSent && loadingSuggested;

    /** Shared circular poke button used across all sections */
    const renderPokeButton = useCallback((
        userId: string,
        variant: 'poke' | 'pokeBack' | 'undo',
    ) => {
        const isPoked = variant === 'undo';
        const isPokeBack = variant === 'pokeBack';
        return (
            <TouchableOpacity
                style={[
                    styles.pokeButton,
                    isPoked
                        ? { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }
                        : isPokeBack
                            ? { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }
                            : { borderColor: theme.colors.border },
                ]}
                onPress={() => isPoked
                    ? unpokeMutation.mutate(userId)
                    : pokeMutation.mutate(userId)
                }
                disabled={pokeMutation.isPending || unpokeMutation.isPending}
                activeOpacity={0.7}
                accessibilityLabel={isPoked ? 'Unpoke' : 'Poke'}
            >
                <FontAwesome5
                    name="hand-point-right"
                    size={18}
                    color={isPoked || isPokeBack ? '#fff' : theme.colors.text}
                    solid={isPoked}
                />
            </TouchableOpacity>
        );
    }, [theme, pokeMutation, unpokeMutation]);

    const renderReceivedItem = useCallback((item: ReceivedPoke) => (
        <View key={item.id} style={[styles.row, { borderBottomColor: theme.colors.border }]}>
            <TouchableOpacity
                style={styles.userInfo}
                onPress={() => navigateToProfile(item.user.username)}
                activeOpacity={0.7}
            >
                <Avatar source={item.user.avatar || undefined} size={40} />
                <View style={styles.userText}>
                    <ThemedText style={styles.userName} numberOfLines={1}>
                        {item.user.name}
                    </ThemedText>
                    <ThemedText className="text-muted-foreground" style={styles.userMeta} numberOfLines={1}>
                        {formatRelativeTimeLocalized(item.createdAt, t)}
                        {item.pokeCount > 1 ? ` \u00B7 ${item.pokeCount} ${t('pokes.count', { defaultValue: 'pokes' })}` : ''}
                    </ThemedText>
                </View>
            </TouchableOpacity>
            {renderPokeButton(item.user.id, item.pokedBack ? 'undo' : 'pokeBack')}
        </View>
    ), [theme, navigateToProfile, renderPokeButton, t]);

    const renderSentItem = useCallback((item: SentPoke) => (
        <View key={item.id} style={[styles.row, { borderBottomColor: theme.colors.border }]}>
            <TouchableOpacity
                style={styles.userInfo}
                onPress={() => navigateToProfile(item.user.username)}
                activeOpacity={0.7}
            >
                <Avatar source={item.user.avatar || undefined} size={40} />
                <View style={styles.userText}>
                    <ThemedText style={styles.userName} numberOfLines={1}>
                        {item.user.name}
                    </ThemedText>
                    <ThemedText className="text-muted-foreground" style={styles.userMeta} numberOfLines={1}>
                        {formatRelativeTimeLocalized(item.createdAt, t)}
                    </ThemedText>
                </View>
            </TouchableOpacity>
            {renderPokeButton(item.user.id, 'undo')}
        </View>
    ), [theme, navigateToProfile, renderPokeButton, t]);

    const renderSuggestedItem = useCallback((item: SuggestedPoke) => (
        <View key={item.user.id} style={[styles.row, { borderBottomColor: theme.colors.border }]}>
            <TouchableOpacity
                style={styles.userInfo}
                onPress={() => navigateToProfile(item.user.username)}
                activeOpacity={0.7}
            >
                <Avatar source={item.user.avatar || undefined} size={40} />
                <View style={styles.userText}>
                    <ThemedText style={styles.userName} numberOfLines={1}>
                        {item.user.name}
                    </ThemedText>
                    <ThemedText className="text-muted-foreground" style={styles.userMeta} numberOfLines={1}>
                        @{item.user.username}
                    </ThemedText>
                </View>
            </TouchableOpacity>
            {renderPokeButton(item.user.id, 'poke')}
        </View>
    ), [theme, navigateToProfile, renderPokeButton, t]);

    const renderSectionHeader = useCallback((
        title: string,
        count?: number,
        showAll?: boolean,
        onToggle?: () => void,
    ) => (
        <View style={styles.sectionHeader}>
            <ThemedText style={styles.sectionTitle}>
                {title}
                {count != null && count > 0 ? (
                    <ThemedText className="text-muted-foreground" style={styles.sectionCount}> ({count})</ThemedText>
                ) : null}
            </ThemedText>
            {onToggle && (
                <TouchableOpacity onPress={onToggle} activeOpacity={0.7}>
                    <ThemedText style={[styles.seeAll, { color: theme.colors.primary }]}>
                        {showAll
                            ? t('pokes.showLess', { defaultValue: 'Show less' })
                            : t('pokes.seeAll', { defaultValue: 'See all' })}
                    </ThemedText>
                </TouchableOpacity>
            )}
        </View>
    ), [theme, t]);

    const renderContent = () => {
        if (!isAuthenticated) {
            return (
                <ThemedView className="flex-1 justify-center items-center px-5">
                    <ThemedText className="text-base text-center text-muted-foreground">
                        {t('state.no_session')}
                    </ThemedText>
                </ThemedView>
            );
        }

        if (isLoading && !refreshing) {
            return (
                <ThemedView className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
                </ThemedView>
            );
        }

        if (errorReceived) {
            return (
                <ErrorComponent
                    title={t('pokes.error.load', { defaultValue: 'Failed to load pokes' })}
                    message={t('pokes.error.message', { defaultValue: 'Unable to fetch your pokes. Please try again.' })}
                    onRetry={handleRefresh}
                    hideBackButton={true}
                    style={{ flex: 1 }}
                />
            );
        }

        const isEmpty = receivedPokes.length === 0 && sentPokes.length === 0 && suggestions.length === 0;

        if (isEmpty && !isLoading) {
            return (
                <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ paddingBottom: 40 }}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            colors={[theme.colors.primary]}
                            tintColor={theme.colors.primary}
                        />
                    }
                >
                    <EmptyState
                        title={t('pokes.empty.title', { defaultValue: 'No pokes yet' })}
                        subtitle={t('pokes.empty.subtitle', { defaultValue: 'When someone pokes you, it will show up here. Poke your followers to get started!' })}
                        customIcon={
                            <View style={[styles.emptyIcon, { backgroundColor: theme.colors.surfaceSecondary ?? `${theme.colors.border}33` }]}>
                                <FontAwesome5 name="hand-point-right" size={36} color={theme.colors.textSecondary} solid />
                            </View>
                        }
                    />
                    <SuggestedUsers
                        title={t('pokes.peopleToFollow', { defaultValue: 'People you may know' })}
                        maxCards={10}
                        hideDismiss
                    />
                </ScrollView>
            );
        }

        return (
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 40 }}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        colors={[theme.colors.primary]}
                        tintColor={theme.colors.primary}
                    />
                }
                showsVerticalScrollIndicator={false}
            >
                {/* Followers who poked you */}
                {receivedPokes.length > 0 && (
                    <View>
                        {renderSectionHeader(
                            t('pokes.receivedTitle', { defaultValue: 'Followers who poked you' }),
                        )}
                        {receivedPokes.map(renderReceivedItem)}
                    </View>
                )}

                {/* Followers you poked */}
                {sentPokes.length > 0 && (
                    <View>
                        {renderSectionHeader(
                            t('pokes.sentTitle', { defaultValue: 'Followers you poked' }),
                            sentPokes.length,
                            showAllSent,
                            sentPokes.length > SENT_PREVIEW_COUNT ? () => setShowAllSent((v) => !v) : undefined,
                        )}
                        {visibleSent.map(renderSentItem)}
                    </View>
                )}

                {/* Suggested — people to poke */}
                {suggestions.length > 0 && (
                    <View>
                        {renderSectionHeader(
                            t('pokes.suggestedTitle', { defaultValue: 'Suggested' }),
                            undefined,
                            showAllSuggested,
                            suggestions.length > SUGGESTED_PREVIEW_COUNT ? () => setShowAllSuggested((v) => !v) : undefined,
                        )}
                        {visibleSuggested.map(renderSuggestedItem)}
                    </View>
                )}

                {/* People you may know */}
                <SuggestedUsers
                    title={t('pokes.peopleToFollow', { defaultValue: 'People you may know' })}
                    maxCards={10}
                />
            </ScrollView>
        );
    };

    return (
        <>
            <SEO
                title={t('pokes.seo.title', { defaultValue: 'Pokes' })}
                description={t('pokes.seo.description', { defaultValue: 'See who poked you and poke them back' })}
            />
            <SafeAreaView className="flex-1 bg-background" edges={['top']}>
                <ThemedView className="flex-1">
                    <Header
                        options={{
                            title: t('pokes.title', { defaultValue: 'Pokes' }),
                            leftComponents: [
                                <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                    />
                    {renderContent()}
                </ThemedView>
            </SafeAreaView>
        </>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        ...Platform.select({ web: { cursor: 'pointer' as const } }),
    },
    userInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 10,
    },
    userText: {
        marginLeft: 10,
        flex: 1,
    },
    userName: {
        fontSize: 14,
        fontWeight: '600',
    },
    userMeta: {
        fontSize: 12,
        marginTop: 1,
    },
    pokeButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
    },
    sectionTitle: {
        fontSize: 15,
        fontWeight: '700',
    },
    sectionCount: {
        fontSize: 15,
        fontWeight: '400',
    },
    seeAll: {
        fontSize: 13,
        fontWeight: '600',
    },
    emptyIcon: {
        width: 72,
        height: 72,
        borderRadius: 36,
        justifyContent: 'center',
        alignItems: 'center',
    },
});
