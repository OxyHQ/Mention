import React, { useMemo, useContext } from 'react';
import { useRouter, usePathname } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useAuth } from '@oxyhq/services';
import { createScopedLogger } from '@/lib/logger';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import { confirmDialog } from '@/utils/alerts';
import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { show as toast } from '@oxyhq/bloom/toast';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import type { HydratedPost, FeedType } from '@mention/shared-types';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
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
import { Ionicons } from '@expo/vector-icons';
import PostInsightsSheet from '@/components/Post/PostInsightsSheet';
import ReplySettingsSheet, { type ReplyPermission } from '@/components/Compose/ReplySettingsSheet';
import ReportModal from '@/components/report/ReportModal';
import { muteService } from '@/services/muteService';
import { reportService } from '@/services/reportService';

const logger = createScopedLogger('usePostActions');

interface ActionItem {
    icon: React.ReactNode;
    text: string;
    onPress: () => void;
    color?: string;
}

interface UsePostActionsParams {
    viewPost: HydratedPost;
    isOwner: boolean;
    isSaved: boolean;
    hasArticle: boolean;
    hasSources: boolean;
    onSave: () => Promise<void>;
    onOpenArticle: () => void;
    onOpenSources: () => void;
}

interface PostActionsResult {
    insightsAction: ActionItem[];
    saveActionGroup: ActionItem[];
    deleteAction: ActionItem[];
    articleAction: ActionItem[];
    sourcesAction: ActionItem[];
    muteReportAction: ActionItem[];
    copyLinkAction: ActionItem[];
}

export function usePostActions({
    viewPost,
    isOwner,
    isSaved,
    hasArticle,
    hasSources,
    onSave,
    onOpenArticle,
    onOpenSources,
}: UsePostActionsParams): PostActionsResult {
    const { user } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();
    const safeBack = useSafeBack();
    const bottomSheet = useContext(BottomSheetContext);
    const removePostEverywhere = usePostsStore((s) => s.removePostEverywhere);

    return useMemo(() => {
        const postId = viewPost?.id;
        const postUrl = `https://mention.earth/p/${postId}`;
        const isPinned = Boolean(viewPost?.metadata?.isPinned);
        const isPostDetail = (pathname || '').startsWith('/p/');

        const handleDelete = async () => {
            try { bottomSheet.openBottomSheet(false); } catch (e) { logger.warn('Failed to close bottom sheet'); }
            const confirmed = await confirmDialog({
                title: t('postActions.deletePost'),
                message: t('postActions.deleteConfirmMessage'),
                okText: t('postActions.delete'),
                cancelText: t('postActions.cancel'),
                destructive: true,
            });
            if (!confirmed) return;

            try {
                await feedService.deletePost(postId);
            } catch (e) {
                logger.error('Delete API failed', { error: e });
                toast(t('postActions.failedToDeletePost'), { type: 'error' });
                return;
            }
            try {
                if (typeof removePostEverywhere === 'function') {
                    removePostEverywhere(postId);
                } else {
                    const store = usePostsStore.getState();
                    const types: FeedType[] = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved', 'for_you', 'following'];
                    types.forEach((feedType) => {
                        try { store.removePostLocally(postId, feedType); } catch (e) { logger.warn(`Failed to remove post from ${feedType} feed`); }
                    });
                }
                if (isPostDetail) safeBack();
            } catch (err) {
                logger.error('Error removing post locally', { error: err });
            }
        };

        const insightsAction = isOwner ? [{
            icon: <AnalyticsIcon size={20} className="text-muted-foreground" />,
            text: t('postActions.insights'),
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

        const saveActionGroup: ActionItem[] = [];

        if (!isSaved) {
            saveActionGroup.push({
                icon: <Bookmark size={20} className="text-muted-foreground" />,
                text: t('postActions.save'),
                onPress: async () => { await onSave(); bottomSheet.openBottomSheet(false); }
            });
        } else {
            saveActionGroup.push({
                icon: <BookmarkActive size={20} className="text-muted-foreground" />,
                text: t('postActions.unsave'),
                onPress: async () => { await onSave(); bottomSheet.openBottomSheet(false); }
            });
        }

        // Edit action - only for owner, within 30-minute window
        if (isOwner) {
            const createdAtRaw = viewPost?.metadata?.createdAt;
            const createdAtMs = createdAtRaw ? new Date(createdAtRaw).getTime() : 0;
            const withinEditWindow = createdAtMs > 0 && (Date.now() - createdAtMs) < 30 * 60 * 1000;
            if (withinEditWindow) {
                saveActionGroup.push({
                    icon: <Ionicons name="create-outline" size={20} color={theme.colors.textSecondary} />,
                    text: t('postActions.edit'),
                    onPress: () => {
                        bottomSheet.openBottomSheet(false);
                        router.push(`/compose?editPostId=${postId}`);
                    }
                });
            }
        }

        if (isOwner) {
            saveActionGroup.push({
                icon: isPinned
                    ? <UnpinIcon size={20} className="text-muted-foreground" />
                    : <PinIcon size={20} className="text-muted-foreground" />,
                text: isPinned ? t('postActions.unpinFromProfile') : t('postActions.pinToProfile'),
                onPress: async () => {
                    try {
                        await feedService.updatePostSettings(postId, { isPinned: !isPinned });
                    } catch (e) {
                        toast(isPinned ? t('postActions.failedToUnpinPost') : t('postActions.failedToPinPost'), { type: 'error' });
                    }
                    bottomSheet.openBottomSheet(false);
                }
            });
        }

        if (isOwner) {
            const isHidden = Boolean(viewPost?.metadata?.hideEngagementCounts);
            saveActionGroup.push({
                icon: <HideIcon size={20} className="text-muted-foreground" />,
                text: isHidden ? t('postActions.showEngagementCounts') : t('postActions.hideEngagementCounts'),
                onPress: async () => {
                    try {
                        await feedService.updatePostSettings(postId, { hideEngagementCounts: !isHidden });
                    } catch (e) {
                        toast(t('postActions.failedToUpdateEngagement'), { type: 'error' });
                    }
                    bottomSheet.openBottomSheet(false);
                }
            });
        }

        if (isOwner) {
            saveActionGroup.push({
                icon: <ChevronRightIcon size={20} className="text-muted-foreground" />,
                text: t('postActions.replyOptions'),
                onPress: () => {
                    bottomSheet.setBottomSheetContent(
                        <ReplySettingsSheet
                            replyPermission={viewPost?.metadata?.replyPermission ?? ['anyone']}
                            onReplyPermissionChange={async (permission) => {
                                try {
                                    await feedService.updatePostSettings(postId, { replyPermission: permission });
                                } catch (e) {
                                    toast(t('postActions.failedToUpdateReplyPermissions'), { type: 'error' });
                                }
                            }}
                            quotesDisabled={viewPost?.metadata?.quotesDisabled || false}
                            onQuotesDisabledChange={async (disabled) => {
                                try {
                                    await feedService.updatePostSettings(postId, { quotesDisabled: disabled });
                                } catch (e) {
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

        const deleteAction = isOwner ? [
            { icon: <TrashIcon size={20} className="text-destructive" />, text: t('postActions.delete'), onPress: handleDelete, color: theme.colors.error }
        ] : [];

        const articleAction = hasArticle ? [{
            icon: <ArticleIcon size={20} className="text-muted-foreground" />,
            text: t('post.viewArticle', { defaultValue: 'View article' }),
            onPress: () => {
                onOpenArticle();
            }
        }] : [];

        const sourcesAction = hasSources ? [{
            icon: <SourcesIcon size={20} className="text-muted-foreground" />,
            text: t('post.viewSources', { defaultValue: 'View sources' }),
            onPress: () => {
                onOpenSources();
            }
        }] : [];

        const handleMuteUser = async () => {
            try { bottomSheet.openBottomSheet(false); } catch (e) { logger.warn('Failed to close bottom sheet'); }
            const userId = viewPost?.user?.id;
            const username = viewPost?.user?.handle || viewPost?.user?.name || 'this user';

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

        const muteReportAction: ActionItem[] = [];

        if (!isOwner) {
            const username = viewPost?.user?.handle || viewPost?.user?.name || 'user';
            muteReportAction.push({
                icon: <MuteIcon size={20} className="text-muted-foreground" />,
                text: t('postActions.muteUser', { username }),
                onPress: handleMuteUser,
            });

            muteReportAction.push({
                icon: <ReportIcon size={20} className="text-destructive" />,
                text: t('postActions.reportPost'),
                onPress: handleReportPost,
                color: theme.colors.error,
            });
        }

        const copyLinkAction = [{
            icon: <LinkIcon size={20} className="text-muted-foreground" />,
            text: t('postActions.copyLink'),
            onPress: async () => {
                try {
                    if (Platform.OS === 'web') {
                        await navigator.clipboard.writeText(postUrl);
                    } else {
                        await Clipboard.setStringAsync(postUrl);
                    }
                } catch (e) { logger.warn('Failed to copy link'); }
                bottomSheet.openBottomSheet(false);
            }
        }];

        return {
            insightsAction,
            saveActionGroup,
            deleteAction,
            articleAction,
            sourcesAction,
            muteReportAction,
            copyLinkAction,
        };
    }, [viewPost, isOwner, isSaved, hasArticle, hasSources, onSave, onOpenArticle, onOpenSources, theme, t, bottomSheet, router, pathname, safeBack, removePostEverywhere]);
}

