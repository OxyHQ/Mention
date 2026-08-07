import React from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { useAuth } from '@oxyhq/services/ui/client';

import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { SEO } from '@/components/SEO';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import { ThemedText } from '@/components/ThemedText';
import { useSafeBack } from '@/hooks/useSafeBack';
import { feedService } from '@/services/feedService';
import { publicQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { usePostSelector } from '@/stores/postsStore';
import { formatFullTimestamp } from '@/utils/dateUtils';

/**
 * A post's public correction trail (route `/p/<id>/corrections`).
 *
 * A channel is a publication, so its posts stay editable for their whole life
 * instead of for the 30 minutes a personal post gets. This screen is the other
 * half of that bargain: every version the post has had, oldest first, ending
 * with what it says now — so "corrected" is something a reader can check rather
 * than something they are told.
 *
 * There is no author on a version, deliberately. A channel's writer is disclosed
 * only when the channel opts in, and a correction is made by exactly such a
 * writer, so naming one here would route around that setting.
 */
export default function PostCorrectionsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const postId = String(id);
    const safeBack = useSafeBack();
    const { t } = useTranslation();
    const { user } = useAuth();

    const { data, isLoading, isError, refetch } = useQuery({
        queryKey: publicQueryKeys.postCorrections(postId),
        queryFn: () => feedService.getPostCorrections(postId),
        enabled: Boolean(postId),
    });

    // The live post supplies the newest version, and the shared post store is
    // preferred over the query for it: an edit made in the composer writes the
    // updated post straight back there (`cachePosts`) and nowhere else, so
    // arriving here from a correction shows the text that was just saved. The
    // query is only the loader for the case the store has nothing — a link
    // opened cold — which is why it is disabled whenever the store answers.
    const cachedPost = usePostSelector(postId);
    const { data: fetchedPost } = useQuery({
        queryKey: viewerQueryKeys.post(user?.id, postId),
        queryFn: () => feedService.getPostById(postId),
        enabled: Boolean(postId) && !cachedPost,
    });
    const currentText = (cachedPost ?? fetchedPost)?.content?.text ?? '';

    const corrections = data?.corrections ?? [];
    // `total` counts corrections MADE and never goes down; retention bounds how
    // many superseded bodies are still readable. The difference is versions this
    // screen cannot show, and saying so is the honest alternative to a trail that
    // silently skips revision numbers.
    const droppedVersions = Math.max((data?.total ?? 0) - corrections.length, 0);
    const title = t('post.corrections.title', { defaultValue: 'Correction history' });

    return (
        <SafeAreaView className="flex-1" edges={['top']}>
            <SEO
                title={title}
                description={t('post.corrections.description', {
                    defaultValue: 'Every version of this post on Mention',
                })}
            />
            {/* Same chrome contract as every other secondary screen:
                PanelStickyHeader owns the web sticky inset and the opaque panel
                surface, so the inner Header hands sticky ownership over. */}
            <PanelStickyHeader level={0}>
                <Header
                    options={{
                        title,
                        leftComponents: [
                            <IconButton key="back" variant="icon" onPress={safeBack}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    disableSticky
                />
            </PanelStickyHeader>

            <ScrollView className="flex-1" contentContainerClassName="pb-16">
                <ThemedText className="px-4 pb-3 pt-1 font-primary text-[13px] text-muted-foreground">
                    {t('post.corrections.intro', {
                        defaultValue:
                            'This post has been changed since it was published. Every version it has had is listed here, oldest first.',
                    })}
                </ThemedText>

                {isLoading ? (
                    <View className="items-center py-10">
                        <SpinnerIcon size={20} className="text-primary" />
                    </View>
                ) : isError ? (
                    // An unreachable trail must not render as an empty one: "no
                    // corrections" over an outage would say the post was never
                    // changed, which is the opposite of what the marker promised.
                    <View className="items-center gap-3 px-4 py-10">
                        <ThemedText className="text-center font-primary text-sm text-muted-foreground">
                            {t('post.corrections.error', {
                                defaultValue: "Couldn't load this post's correction history.",
                            })}
                        </ThemedText>
                        <TouchableOpacity
                            accessibilityRole="button"
                            onPress={() => void refetch()}
                            className="rounded-full bg-primary px-4 py-2"
                        >
                            <ThemedText className="font-primary text-sm font-semibold text-primary-foreground">
                                {t('post.corrections.retry', { defaultValue: 'Try again' })}
                            </ThemedText>
                        </TouchableOpacity>
                    </View>
                ) : corrections.length === 0 ? (
                    <ThemedText className="px-4 py-10 text-center font-primary text-sm text-muted-foreground">
                        {t('post.corrections.empty', {
                            defaultValue: 'This post has not been corrected.',
                        })}
                    </ThemedText>
                ) : (
                    <>
                        {droppedVersions > 0 ? (
                            <ThemedText className="px-4 pb-3 font-primary text-[13px] text-muted-foreground">
                                {t('post.corrections.truncated', {
                                    count: droppedVersions,
                                    defaultValue:
                                        '{{count}} versions in between are no longer kept. The version numbers below skip them.',
                                })}
                            </ThemedText>
                        ) : null}

                        {corrections.map((correction) => (
                            <Version
                                key={correction.revision}
                                title={
                                    // Revision 1 is the body the post was
                                    // PUBLISHED with, and it is exempt from
                                    // retention eviction, so this is the one
                                    // label the trail can always say plainly.
                                    correction.revision === 1
                                        ? t('post.corrections.originalVersion', {
                                              defaultValue: 'As first published',
                                          })
                                        : t('post.corrections.version', {
                                              revision: correction.revision,
                                              defaultValue: 'Version {{revision}}',
                                          })
                                }
                                // `correctedAt` is when this body was REPLACED,
                                // not when it was written, so the date reads
                                // "Replaced …" — labelling it as the version's
                                // own date would tell the reader the post said
                                // this FROM then on, which is backwards.
                                subtitle={t('post.corrections.replaced', {
                                    timestamp: formatFullTimestamp(correction.correctedAt),
                                    defaultValue: 'Replaced {{timestamp}}',
                                })}
                                text={correction.previousText}
                            />
                        ))}

                        {currentText ? (
                            <Version
                                title={t('post.corrections.currentVersion', {
                                    defaultValue: 'Current version',
                                })}
                                subtitle={t('post.corrections.since', {
                                    timestamp: formatFullTimestamp(
                                        corrections[corrections.length - 1].correctedAt,
                                    ),
                                    defaultValue: 'Since {{timestamp}}',
                                })}
                                text={currentText}
                            />
                        ) : null}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

/** One entry in the trail: what it was called, when, and what it said. */
function Version({
    title,
    subtitle,
    text,
}: {
    title: string;
    subtitle: string;
    text: string;
}) {
    return (
        <View className="border-border border-t px-4 py-4">
            <ThemedText className="font-primary text-[15px] font-semibold">{title}</ThemedText>
            <ThemedText className="font-primary text-[13px] text-muted-foreground">
                {subtitle}
            </ThemedText>
            <LinkifiedText text={text} className="text-foreground mt-2 text-[15px]" />
        </View>
    );
}
