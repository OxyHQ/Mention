import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxyhq/bloom/loading';
import { SettingsListGroup } from '@oxyhq/bloom/settings-list';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services/ui/client';
import { useFollowTarget } from '@oxyhq/services';
import type { TopicData } from '@oxyhq/core';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { topicService } from '@/services/topicService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { cn } from '@/lib/utils';
import {
    useFollowedTopics,
    useTopicFollowTargetId,
    type FollowedTopic,
} from '@/hooks/useTopicFollows';
import { resolveTopicChipAction, topicFollowUri } from '@/services/followGraph';

/**
 * Your interests — a searchable grid of topics, where selecting one FOLLOWS it.
 *
 * This screen used to write a list of slugs to `interests.tags` on the profile
 * settings. Nothing read that field: the feed learns topics from behaviour, not
 * from it. A chip now creates a real edge in the user-owned follow graph
 * instead, which every Oxy application shares — so a topic picked here is picked
 * everywhere, and giving it up here gives it up everywhere.
 *
 * `interests.tags` is deliberately left alone rather than migrated or
 * dual-written. Writing both would make two sources of truth for one intention,
 * and whichever one a future reader picked would be a coin flip.
 *
 * The topics are Oxy's (`GET /topics` proxies to the Oxy API) and so is the kind
 * — `oxy.topic` is seeded as a platform kind — so Mention registers nothing at
 * all here. See `services/followGraph.ts`.
 */
export default function InterestsSettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { canUsePrivateApi, isPrivateApiPending } = useAuth();

    const [query, setQuery] = useState('');
    const trimmedQuery = query.trim();

    /*
     * An empty box shows the curated categories; a query searches the catalogue.
     * ONE query key covers both, because they answer the same question — what
     * should the grid show — and a second key would let the two disagree about
     * which is on screen.
     *
     * Not gated on the viewer: `/topics` is mounted on the public API and the
     * catalogue is the same for everyone. Only the FOLLOW state below is
     * viewer-scoped. Both service calls resolve to an empty list rather than
     * throwing, so the grid always settles.
     */
    const catalogue = useQuery({
        queryKey: publicQueryKeys.topicCatalogue(trimmedQuery),
        queryFn: () =>
            trimmedQuery.length > 0
                ? topicService.search(trimmedQuery, 40)
                : topicService.getCategories(),
        staleTime: 5 * 60 * 1000,
    });

    const followed = useFollowedTopics();
    const topics = useMemo(() => catalogue.data ?? [], [catalogue.data]);

    if (isPrivateApiPending) {
        return (
            <InterestsShell t={t} safeBack={safeBack}>
                <View className="flex-1 justify-center items-center bg-background">
                    <Loading className="text-primary" size="large" />
                </View>
            </InterestsShell>
        );
    }

    if (!canUsePrivateApi) {
        return (
            <InterestsShell t={t} safeBack={safeBack}>
                <OxyAuthPrompt
                    label={t('settings.interests.signInRequired', {
                        defaultValue: 'Sign in to choose your interests',
                    })}
                    description={t('settings.interests.signInRequiredDesc', {
                        defaultValue: 'Pick topics so we can tailor your feed.',
                    })}
                />
            </InterestsShell>
        );
    }

    return (
        <InterestsShell t={t} safeBack={safeBack}>
            <ScrollView
                className="flex-1"
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                <View className="px-4 pb-2">
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={t('settings.interests.searchPlaceholder', {
                            defaultValue: 'Search topics',
                        })}
                        accessibilityLabel={t('settings.interests.searchLabel', {
                            defaultValue: 'Search topics',
                        })}
                        className="bg-muted text-foreground rounded-2xl px-4 py-3 text-[15px]"
                    />
                </View>

                <SettingsListGroup
                    title={t('settings.interests.title', { defaultValue: 'Your interests' })}
                    footer={t('settings.interests.description', {
                        defaultValue:
                            'Topics you follow shape your feed, and come with you to every Oxy app.',
                    })}
                >
                    {catalogue.isLoading ? (
                        <View className="py-8 items-center">
                            <Loading className="text-primary" size="large" />
                        </View>
                    ) : topics.length === 0 ? (
                        <View className="px-4 py-6">
                            <Text className="text-[13px] text-muted-foreground">
                                {trimmedQuery.length > 0
                                    ? t('settings.interests.noMatches', {
                                        query: trimmedQuery,
                                        defaultValue: 'No topics match “{{query}}”.',
                                    })
                                    : t('settings.interests.noTopics', {
                                        defaultValue: 'No topics are available yet.',
                                    })}
                            </Text>
                        </View>
                    ) : (
                        <View className="flex-row flex-wrap gap-2 px-4 py-4">
                            {topics.map((topic) => (
                                <TopicChip
                                    key={topic.slug}
                                    topic={topic}
                                    seeded={followed.byUri.get(topicFollowUri(topic.slug))}
                                    // Until the sweep lands, a chip cannot tell
                                    // "not followed" from "not asked yet", and
                                    // offering to follow something already
                                    // followed is the one mistake this screen
                                    // must not make.
                                    followsReady={followed.isReady}
                                />
                            ))}
                        </View>
                    )}
                </SettingsListGroup>
            </ScrollView>
        </InterestsShell>
    );
}

interface ShellProps {
    t: (key: string, options?: { defaultValue?: string }) => string;
    safeBack: () => void;
    children: React.ReactNode;
}

/** The chrome every branch of this screen shares, so the header cannot drift. */
function InterestsShell({ t, safeBack, children }: ShellProps) {
    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.interests.title', { defaultValue: 'Your interests' }),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder
                disableSticky
            />
            {children}
        </ThemedView>
    );
}

interface TopicChipProps {
    topic: TopicData;
    seeded: FollowedTopic | undefined;
    followsReady: boolean;
}

/**
 * ONE topic, as a chip whose selected state IS the follow.
 *
 * A chip rather than the SDK's `FollowTargetButton` because the two want
 * opposite fills: that button is a call to action, so it draws PRIMARY when you
 * do NOT follow yet, while a selected chip in a picker has to be the filled one.
 * A grid of filled chips meaning "none selected" is worse than a local
 * affordance. The state machine is still the SDK's — `useFollowTarget` owns the
 * optimistic update, the rollback and the store — and only the drawing is local.
 */
function TopicChip({ topic, seeded, followsReady }: TopicChipProps) {
    const { t } = useTranslation();

    const targetId = useTopicFollowTargetId({
        slug: topic.slug,
        displayName: topic.displayName,
        ...(topic.icon ? { icon: topic.icon } : {}),
        ...(seeded ? { seededTargetId: seeded.targetId } : {}),
    });

    const follow = useFollowTarget(
        targetId,
        seeded ? { initialStatus: seeded.status } : undefined,
    );

    const isOffHere = follow.isFollowing && follow.status.applicationMode === 'disabled';

    const onPress = useCallback(() => {
        switch (
        resolveTopicChipAction({
            isFollowing: follow.isFollowing,
            applicationMode: follow.status.applicationMode,
        })
        ) {
            case 'follow':
                void follow.follow();
                return;
            case 'enable-here':
                void follow.enableHere();
                return;
            case 'unfollow':
                void follow.unfollow();
        }
    }, [follow]);

    /*
     * Inert until BOTH the sweep has settled and a target exists. Pressing
     * earlier would either act on a relationship whose state is not yet known or
     * address a row that does not exist yet.
     */
    const disabled = !followsReady || !targetId || follow.isPending;

    const label = topic.displayName || topic.slug;

    return (
        <TouchableOpacity
            className={cn(
                'px-4 py-2.5 rounded-full border',
                // `bg-muted`, not `bg-secondary`: under Bloom 0.74's colour
                // system `secondary` is an ACCENT and renders red here, so an
                // unpicked interest looked like a destructive action. `muted` is
                // the neutral surface, and the same token the search box above
                // uses — an unpicked chip should read as "not chosen", not as a
                // warning.
                follow.isFollowing ? 'bg-primary border-primary' : 'bg-muted border-border',
                // Followed globally, switched off in Mention: still selected —
                // the person does follow it — but visibly not acting here, and
                // one press turns it back on rather than giving it up everywhere.
                isOffHere && 'opacity-60',
                disabled && 'opacity-40',
            )}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected: follow.isFollowing, disabled }}
            accessibilityLabel={
                isOffHere
                    ? t('settings.interests.chipOffHere', {
                        topic: label,
                        defaultValue: 'Show {{topic}} in Mention again',
                    })
                    : follow.isFollowing
                        ? t('settings.interests.chipUnfollow', {
                            topic: label,
                            defaultValue: 'Unfollow {{topic}}',
                        })
                        : t('settings.interests.chipFollow', {
                            topic: label,
                            defaultValue: 'Follow {{topic}}',
                        })
            }
            activeOpacity={0.7}
        >
            <Text
                className={cn(
                    'text-sm',
                    follow.isFollowing
                        ? 'text-primary-foreground font-semibold'
                        : 'text-foreground font-medium',
                )}
            >
                {label}
            </Text>
        </TouchableOpacity>
    );
}
