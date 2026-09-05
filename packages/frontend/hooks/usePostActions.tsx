import React, { useMemo, useContext } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useAuth } from '@oxyhq/services/ui/client';
import { createLogger } from '@oxyhq/core/logger';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import { confirmDialog } from '@/utils/alerts';
import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { toast } from '@oxyhq/bloom/toast';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { HydratedPost } from '@mention/shared-types';
import type { FeedItem } from '@/db';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { LaneIcon } from '@/assets/icons/lane-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { TrashIcon } from '@/assets/icons/trash-icon';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { LinkIcon } from '@/assets/icons/link-icon';
import { PinIcon, UnpinIcon } from '@/assets/icons/pin-icon';
import { HideIcon } from '@/assets/icons/hide-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { MuteIcon } from '@/assets/icons/mute-icon';
import { ReportIcon } from '@/assets/icons/report-icon';
import Ionicons from '@expo/vector-icons/Ionicons';
import PostInsightsSheet from '@/components/Post/PostInsightsSheet';
import ReplySettingsSheet from '@/components/Compose/ReplySettingsSheet';
import { ReportModal } from '@/components/report/ReportModal';
import { muteService } from '@/services/muteService';
import { lanesService } from '@/services/lanesService';
import { noteLaneListsChanged } from '@/stores/laneInvalidation';
import { reportService } from '@/services/reportService';
import { AddToListSheet } from '@/components/Lists/AddToListSheet';
import LanePickerSheet from '@/components/Compose/LanePickerSheet';
import { List as ListIcon } from '@/assets/icons/list-icon';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const logger = createLogger('usePostActions');

interface UsePostActionsParams {
    viewPost: HydratedPost;
    isOwner: boolean;
    /**
     * True only for the FOCUSED post on `/p/<id>` — the one surface where deleting
     * the post must also leave the screen. Passed in rather than read off the
     * route: every mounted row calls this hook, and a route subscription here
     * rebuilds all nine action arrays for every row on every navigation.
     */
    isPostDetail: boolean;
    canViewInsights: boolean;
    canStopSharing: boolean;
    isSaved: boolean;
    hasArticle: boolean;
    hasSources: boolean;
    onSave: () => Promise<void>;
    onOpenArticle: () => void;
    onOpenSources: () => void;
}

interface PostActionsResult {
    insightsAction: ActionMenuAction[];
    saveActionGroup: ActionMenuAction[];
    addToListAction: ActionMenuAction[];
    stopSharingAction: ActionMenuAction[];
    deleteAction: ActionMenuAction[];
    articleAction: ActionMenuAction[];
    sourcesAction: ActionMenuAction[];
    muteReportAction: ActionMenuAction[];
    copyLinkAction: ActionMenuAction[];
}

export function usePostActions({
    viewPost,
    isOwner,
    isPostDetail,
    canViewInsights,
    canStopSharing,
    isSaved,
    hasArticle,
    hasSources,
    onSave,
    onOpenArticle,
    onOpenSources,
}: UsePostActionsParams): PostActionsResult {
    const theme = useTheme();
    const { user } = useAuth();
    const { t } = useTranslation();
    const router = useRouter();
    const safeBack = useSafeBack();
    const bottomSheet = useContext(BottomSheetContext);
    const queryClient = useQueryClient();
    const removePostEverywhere = usePostsStore((s) => s.removePostEverywhere);
    const reinsertPost = usePostsStore((s) => s.reinsertPost);
    const updatePostEverywhere = usePostsStore((s) => s.updatePostEverywhere);

    return useMemo(() => {
        const postId = viewPost?.id;
        const postUrl = `https://mention.earth/p/${postId}`;
        const isPinned = Boolean(viewPost?.metadata?.isPinned);

        const handleDelete = async () => {
            const confirmed = await confirmDialog({
                title: t('postActions.deletePost'),
                message: t('postActions.deleteConfirmMessage'),
                okText: t('postActions.delete'),
                cancelText: t('postActions.cancel'),
                destructive: true,
            });
            if (!confirmed || !postId) return;

            // Snapshot the post BEFORE removing it so a failed delete can roll the
            // optimistic removal back. Prefer the richer cached copy; fall back to
            // the post passed into the hook (the only copy available on web, where
            // SQLite — and therefore the shared cache read — is unavailable).
            const snapshot: FeedItem = usePostsStore.getState().getPostFromDb(postId) ?? viewPost;
            const authorId = viewPost?.user?.id;

            // Optimistic removal: drop it from every feed (SQLite reactive removal
            // on native; memory-mode broadcast on web) so it vanishes instantly —
            // Twitter/Threads-style — instead of lingering through the round-trip.
            removePostEverywhere(postId);
            if (isPostDetail) safeBack();

            try {
                await feedService.deletePost(postId);
                // The pinned slot lives in React Query (ProfileTabs); refetch it so a
                // deleted pinned post clears from the author's profile too.
                if (authorId) {
                    queryClient.invalidateQueries({
                        queryKey: viewerQueryKeys.pinnedPost(user?.id, authorId),
                    });
                }
            } catch (e) {
                logger.error('Delete API failed — rolling back optimistic removal', e);
                // Roll back: the post still exists server-side, so re-insert it and
                // surface the error instead of leaving the UI inconsistent.
                reinsertPost(snapshot);
                toast(t('postActions.failedToDeletePost'), { type: 'error' });
            }
        };

        const insightsAction = canViewInsights ? [{
            icon: <AnalyticsIcon size={20} className="text-muted-foreground" />,
            label: t('postActions.insights'),
            onPress: () => {
                bottomSheet.setBottomSheetContent(
                    <PostInsightsSheet
                        postId={postId || null}
                        onClose={() => bottomSheet.openBottomSheet(false)}
                    />
                );
                bottomSheet.openBottomSheet(true);
            }
        }] : [];

        const saveActionGroup: ActionMenuAction[] = [];

        if (!isSaved) {
            saveActionGroup.push({
                icon: <Bookmark size={20} className="text-muted-foreground" />,
                label: t('postActions.save'),
                onPress: onSave,
            });
        } else {
            saveActionGroup.push({
                icon: <BookmarkActive size={20} className="text-muted-foreground" />,
                label: t('postActions.unsave'),
                onPress: onSave,
            });
        }

        // Edit action — owner only, and the deadline depends on WHO published.
        //
        // A personal post keeps its 30-minute window: the bargain there is that
        // the change lands before the post has really been read, so there is
        // nothing to disclose. A CHANNEL is a publication and its posts stay
        // editable for their whole life, because every change to the body
        // appends to a public correction trail the reader can open — the trail
        // is what buys the permanence, so the window has nothing left to
        // protect. `isOwner` is server-computed and is already true for a
        // channel post's writer, so it needs no widening here.
        if (isOwner) {
            const isChannelPost = viewPost?.user?.kind === 'channel';
            const createdAtRaw = viewPost?.metadata?.createdAt;
            const createdAtMs = createdAtRaw ? new Date(createdAtRaw).getTime() : 0;
            const withinEditWindow = createdAtMs > 0 && (Date.now() - createdAtMs) < 30 * 60 * 1000;
            if (isChannelPost || withinEditWindow) {
                saveActionGroup.push({
                    icon: <Ionicons name="create-outline" size={20} color={theme.colors.textSecondary} />,
                    label: t('postActions.edit'),
                    onPress: () => router.push(`/compose?editPostId=${postId}`),
                });
            }
        }

        if (isOwner) {
            saveActionGroup.push({
                icon: isPinned
                    ? <UnpinIcon size={20} className="text-muted-foreground" />
                    : <PinIcon size={20} className="text-muted-foreground" />,
                label: isPinned ? t('postActions.unpinFromProfile') : t('postActions.pinToProfile'),
                onPress: async () => {
                    const nextPinned = !isPinned;
                    try {
                        await feedService.updatePostSettings(postId, { isPinned: nextPinned });
                        updatePostEverywhere(postId, (prev) => ({
                            ...prev,
                            metadata: { ...prev.metadata, isPinned: nextPinned },
                        }));
                        const authorId = viewPost?.user?.id;
                        if (authorId) {
                            queryClient.invalidateQueries({
                                queryKey: viewerQueryKeys.pinnedPost(user?.id, authorId),
                            });
                        }
                    } catch {
                        toast(isPinned ? t('postActions.failedToUnpinPost') : t('postActions.failedToPinPost'), { type: 'error' });
                    }
                }
            });
        }

        // Moving a post between the author's own lanes sits beside pinning, and
        // for the same reason: neither is an EDIT. There is no 30-minute window
        // here — the write changes no text, does not federate, emits no MTN
        // record and never sets `isEdited` (see `updatePostLane`) — so it is
        // offered for the life of the post, exactly like pin/unpin.
        //
        // A reply or a boost cannot carry a lane at all, so the action is absent
        // rather than present-and-failing.
        const isReplyOrBoost = Boolean(viewPost?.parentPostId) || Boolean(viewPost?.boost);
        if (isOwner && !isReplyOrBoost) {
            saveActionGroup.push({
                icon: <LaneIcon size={20} color={theme.colors.textSecondary} />,
                label: t('lanes.postActions.moveToLane', { defaultValue: 'Move to lane…' }),
                onPress: () => {
                    bottomSheet.setBottomSheetContent(
                        <LanePickerSheet
                            selectedLaneId={viewPost?.lane?.id ?? null}
                            onSelect={async (nextLaneId) => {
                                try {
                                    const lane = await lanesService.setPostLane(postId, nextLaneId);
                                    updatePostEverywhere(postId, (prev) => ({
                                        ...prev,
                                        lane: lane ?? undefined,
                                    }));
                                    // The chip flips instantly through the store
                                    // above; WHICH profile tab the post now sits
                                    // on is server-ordered and paged, so both
                                    // post-list caches have to be told.
                                    noteLaneListsChanged('assignment');
                                } catch (e) {
                                    logger.error('Failed to move post to lane', e);
                                    toast(
                                        t('lanes.postActions.moveFailed', { defaultValue: 'Failed to move this post' }),
                                        { type: 'error' },
                                    );
                                }
                            }}
                            onClose={() => bottomSheet.openBottomSheet(false)}
                        />
                    );
                    bottomSheet.openBottomSheet(true);
                },
            });
        }

        if (isOwner) {
            const isHidden = Boolean(viewPost?.metadata?.hideEngagementCounts);
            saveActionGroup.push({
                icon: <HideIcon size={20} className="text-muted-foreground" />,
                label: isHidden ? t('postActions.showEngagementCounts') : t('postActions.hideEngagementCounts'),
                onPress: async () => {
                    const nextHidden = !isHidden;
                    try {
                        await feedService.updatePostSettings(postId, { hideEngagementCounts: nextHidden });
                        updatePostEverywhere(postId, (prev) => ({
                            ...prev,
                            metadata: { ...prev.metadata, hideEngagementCounts: nextHidden },
                        }));
                    } catch {
                        toast(t('postActions.failedToUpdateEngagement'), { type: 'error' });
                    }
                }
            });
        }

        if (isOwner) {
            saveActionGroup.push({
                icon: <ChevronRightIcon size={20} className="text-muted-foreground" />,
                label: t('postActions.replyOptions'),
                onPress: () => {
                    bottomSheet.setBottomSheetContent(
                        <ReplySettingsSheet
                            replyPermission={viewPost?.metadata?.replyPermission ?? ['anyone']}
                            onReplyPermissionChange={async (permission) => {
                                try {
                                    await feedService.updatePostSettings(postId, { replyPermission: permission });
                                    updatePostEverywhere(postId, (prev) => ({
                                        ...prev,
                                        metadata: { ...prev.metadata, replyPermission: permission },
                                    }));
                                } catch {
                                    toast(t('postActions.failedToUpdateReplyPermissions'), { type: 'error' });
                                }
                            }}
                            quotesDisabled={viewPost?.metadata?.quotesDisabled || false}
                            onQuotesDisabledChange={async (disabled) => {
                                try {
                                    await feedService.updatePostSettings(postId, { quotesDisabled: disabled });
                                    updatePostEverywhere(postId, (prev) => ({
                                        ...prev,
                                        metadata: { ...prev.metadata, quotesDisabled: disabled },
                                    }));
                                } catch {
                                    toast(t('postActions.failedToUpdateQuoteSettings'), { type: 'error' });
                                }
                            }}
                            onClose={() => bottomSheet.openBottomSheet(false)}
                        />
                    );
                    bottomSheet.openBottomSheet(true);
                }
            });
        }

        const stopSharingAction = canStopSharing ? [{
            icon: <Ionicons name="close-circle-outline" size={20} color={theme.colors.error} />,
            label: t('collab.stopSharing', { defaultValue: 'Stop sharing' }),
            onPress: async () => {
                const confirmed = await confirmDialog({
                    title: t('collab.stopSharingTitle', { defaultValue: 'Stop sharing this post?' }),
                    message: t('collab.stopSharingMessage', { defaultValue: 'This post will be removed from your profile. Other collaborators can still see it.' }),
                    okText: t('collab.stopSharing', { defaultValue: 'Stop sharing' }),
                    cancelText: t('postActions.cancel'),
                    destructive: true,
                });
                if (!confirmed || !postId) return;
                try {
                    const result = await feedService.stopCollabSharing(postId);
                    if (result.post) {
                        updatePostEverywhere(postId, () => result.post as HydratedPost);
                    } else {
                        removePostEverywhere(postId);
                    }
                    toast(t('collab.stopSharingSuccess', { defaultValue: 'You stopped sharing this post' }), { type: 'success' });
                } catch (e) {
                    logger.error('Stop sharing failed', e);
                    toast(t('collab.stopSharingFailed', { defaultValue: 'Failed to stop sharing' }), { type: 'error' });
                }
            },
            color: theme.colors.error,
        }] : [];

        const deleteAction = isOwner ? [
            { icon: <TrashIcon size={20} className="text-destructive" />, label: t('postActions.delete'), onPress: handleDelete, color: theme.colors.error }
        ] : [];

        const articleAction = hasArticle ? [{
            icon: <ArticleIcon size={20} className="text-muted-foreground" />,
            label: t('post.viewArticle', { defaultValue: 'View article' }),
            onPress: () => {
                onOpenArticle();
            }
        }] : [];

        const sourcesAction = hasSources ? [{
            icon: <SourcesIcon size={20} className="text-muted-foreground" />,
            label: t('post.viewSources', { defaultValue: 'View sources' }),
            onPress: () => {
                onOpenSources();
            }
        }] : [];

        const handleMuteUser = async () => {
            const userId = viewPost?.user?.id;
            const username = getNormalizedUserHandle(viewPost?.user) || viewPost?.user?.name?.displayName || 'this user';

            if (!userId) {
                toast(t('postActions.unableToMuteUser'), { type: 'error' });
                return;
            }

            const confirmed = await confirmDialog({
                title: t('postActions.muteUser', { username }),
                message: t('postActions.muteConfirmMessage', { username }),
                okText: t('postActions.mute'),
                cancelText: t('postActions.cancel'),
                destructive: false,
            });

            if (!confirmed) return;

            const success = await muteService.muteUser(userId);
            if (success) {
                toast(t('postActions.userMuted', { username }), { type: 'success' });
            } else {
                toast(t('postActions.failedToMuteUser'), { type: 'error' });
            }
        };

        const handleReportPost = () => {
            bottomSheet.setBottomSheetContent(
                <ReportModal
                    visible={true}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                    onSubmit={async (categories, details) => {
                        const success = await reportService.reportPost(postId, categories, details);
                        if (success) {
                            toast(t('postActions.thankYouReport'), { type: 'success' });
                        } else {
                            toast(t('postActions.failedToSubmitReport'), { type: 'error' });
                        }
                    }}
                />
            );
            bottomSheet.openBottomSheet(true);
        };

        const postLane = viewPost?.lane;

        /**
         * Silence ONE track of one publisher, without unfollowing them — the
         * reader's half of the feature.
         *
         * Narrower than muting the author on purpose, so it is offered first: a
         * reader who does not want the dev notes still wants the person.
         */
        const handleMuteLane = async (username: string) => {
            if (!postLane) return;

            const confirmed = await confirmDialog({
                title: t('lanes.postActions.muteLane', {
                    lane: postLane.name,
                    username,
                    defaultValue: 'Mute «{{lane}}» from @{{username}}',
                }),
                message: t('lanes.postActions.muteLaneConfirm', {
                    lane: postLane.name,
                    username,
                    defaultValue: "Posts on «{{lane}}» stop appearing in your feeds. You keep following @{{username}}, and everything else they post still reaches you.",
                }),
                okText: t('postActions.mute'),
                cancelText: t('postActions.cancel'),
                destructive: false,
            });
            if (!confirmed) return;

            try {
                await lanesService.mute(postLane.id);
                // A mute is a filter over EVERY feed this reader opens, so the
                // retained slices all have to be revalidated.
                noteLaneListsChanged('mute');
                toast(
                    t('lanes.postActions.laneMuted', {
                        lane: postLane.name,
                        defaultValue: '«{{lane}}» muted',
                    }),
                    { type: 'success' },
                );
            } catch (e) {
                logger.error('Failed to mute lane', e);
                toast(
                    t('lanes.postActions.muteLaneFailed', { defaultValue: 'Failed to mute this lane' }),
                    { type: 'error' },
                );
            }
        };

        const muteReportAction: ActionMenuAction[] = [];

        if (!isOwner) {
            const username = getNormalizedUserHandle(viewPost?.user) || viewPost?.user?.name?.displayName || 'user';
            if (postLane) {
                muteReportAction.push({
                    icon: <MuteIcon size={20} className="text-muted-foreground" />,
                    label: t('lanes.postActions.muteLane', {
                        lane: postLane.name,
                        username,
                        defaultValue: 'Mute «{{lane}}» from @{{username}}',
                    }),
                    onPress: () => handleMuteLane(username),
                });
            }
            muteReportAction.push({
                icon: <MuteIcon size={20} className="text-muted-foreground" />,
                label: t('postActions.muteUser', { username }),
                onPress: handleMuteUser,
            });

            muteReportAction.push({
                icon: <ReportIcon size={20} className="text-destructive" />,
                label: t('postActions.reportPost'),
                onPress: handleReportPost,
                color: theme.colors.error,
            });
        }

        const addToListAction: ActionMenuAction[] = [];
        const authorId = viewPost?.user?.id;
        if (!isOwner && authorId) {
            const authorHandle = getNormalizedUserHandle(viewPost?.user) || '';
            addToListAction.push({
                icon: <ListIcon size={20} className="text-muted-foreground" />,
                label: t('lists.addTo.menuItem', { defaultValue: 'Add/remove from lists' }),
                onPress: () => {
                    bottomSheet.setBottomSheetContent(
                        <AddToListSheet
                            targetUserId={authorId}
                            targetLabel={authorHandle ? `@${authorHandle}` : undefined}
                            onClose={() => bottomSheet.openBottomSheet(false)}
                        />
                    );
                    bottomSheet.openBottomSheet(true);
                },
            });
        }

        const copyLinkAction = [{
            icon: <LinkIcon size={20} className="text-muted-foreground" />,
            label: t('postActions.copyLink'),
            onPress: async () => {
                try {
                    if (Platform.OS === 'web') {
                        await navigator.clipboard.writeText(postUrl);
                    } else {
                        await Clipboard.setStringAsync(postUrl);
                    }
                } catch { logger.warn('Failed to copy link'); }
            }
        }];

        return {
            insightsAction,
            saveActionGroup,
            addToListAction,
            stopSharingAction,
            deleteAction,
            articleAction,
            sourcesAction,
            muteReportAction,
            copyLinkAction,
        };
    }, [viewPost, isOwner, isPostDetail, canViewInsights, canStopSharing, isSaved, hasArticle, hasSources, onSave, onOpenArticle, onOpenSources, theme, t, bottomSheet, router, safeBack, removePostEverywhere, reinsertPost, updatePostEverywhere, queryClient]);
}
