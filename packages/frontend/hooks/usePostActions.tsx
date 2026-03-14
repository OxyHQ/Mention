import React, { useMemo, useContext } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { useTheme } from './useTheme';
import { useTranslation } from 'react-i18next';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import { confirmDialog } from '@/utils/alerts';
import { Alert, Platform } from 'react-native';
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
    const bottomSheet = useContext(BottomSheetContext);
    const removePostEverywhere = usePostsStore((s) => s.removePostEverywhere);

    return useMemo(() => {
        const postId = viewPost?.id;
        const postUrl = `https://mention.earth/p/${postId}`;
        const isPinned = Boolean(viewPost?.metadata?.isPinned);
        const isPostDetail = (router.pathname || '').startsWith('/p/');

        const handleDelete = async () => {
            try { bottomSheet.openBottomSheet(false); } catch (e) { console.warn('[usePostActions] Failed to close bottom sheet:', e); }
            const confirmed = await confirmDialog({
                title: 'Delete post',
                message: 'Are you sure you want to delete this post? This action cannot be undone.',
                okText: 'Delete',
                cancelText: 'Cancel',
                destructive: true,
            });
            if (!confirmed) return;

            try {
                await feedService.deletePost(postId);
            } catch (e) {
                console.error('Delete API failed', e);
                Alert.alert('Error', 'Failed to delete post');
                return;
            }
            try {
                if (typeof removePostEverywhere === 'function') {
                    removePostEverywhere(postId);
                } else {
                    const store = usePostsStore.getState();
                    const types: FeedType[] = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved', 'for_you', 'following'];
                    types.forEach((feedType) => {
                        try { store.removePostLocally(postId, feedType); } catch (e) { console.warn(`[usePostActions] Failed to remove post from ${feedType} feed:`, e); }
                    });
                }
                if (isPostDetail) router.back();
            } catch (err) {
                console.error('Error removing post locally:', err);
            }
        };

        const insightsAction = isOwner ? [{
            icon: <AnalyticsIcon size={20} className="text-muted-foreground" />,
            text: "Insights",
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
                text: "Save",
                onPress: async () => { await onSave(); bottomSheet.openBottomSheet(false); }
            });
        } else {
            saveActionGroup.push({
                icon: <BookmarkActive size={20} className="text-muted-foreground" />,
                text: "Unsave",
                onPress: async () => { await onSave(); bottomSheet.openBottomSheet(false); }
            });
        }

        // Edit action - only for owner, within 30-minute window
        if (isOwner) {
            const createdAtRaw = viewPost?.metadata?.createdAt || viewPost?.createdAt;
            const createdAtMs = createdAtRaw ? new Date(createdAtRaw).getTime() : 0;
            const withinEditWindow = createdAtMs > 0 && (Date.now() - createdAtMs) < 30 * 60 * 1000;
            if (withinEditWindow) {
                saveActionGroup.push({
                    icon: <Ionicons name="create-outline" size={20} color={theme.colors.textSecondary} />,
                    text: "Edit",
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
                text: isPinned ? "Unpin from profile" : "Pin to your profile",
                onPress: async () => {
                    try {
                        await feedService.updatePostSettings(postId, { isPinned: !isPinned });
                    } catch (e) {
                        Alert.alert('Error', isPinned ? 'Failed to unpin post' : 'Failed to pin post');
                    }
                    bottomSheet.openBottomSheet(false);
                }
            });
        }

        if (isOwner) {
            const isHidden = Boolean(viewPost?.metadata?.hideEngagementCounts);
            saveActionGroup.push({
                icon: <HideIcon size={20} className="text-muted-foreground" />,
                text: isHidden ? "Show like and share counts" : "Hide like and share counts",
                onPress: async () => {
                    try {
                        await feedService.updatePostSettings(postId, { hideEngagementCounts: !isHidden });
                    } catch (e) {
                        Alert.alert('Error', 'Failed to update engagement count visibility');
                    }
                    bottomSheet.openBottomSheet(false);
                }
            });
        }

        if (isOwner) {
            saveActionGroup.push({
                icon: <ChevronRightIcon size={20} className="text-muted-foreground" />,
                text: "Reply options",
                onPress: () => {
                    bottomSheet.setBottomSheetContent(
                        <ReplySettingsSheet
                            replyPermission={(viewPost?.metadata?.replyPermission as ReplyPermission) || 'anyone'}
                            onReplyPermissionChange={async (permission) => {
                                try {
                                    await feedService.updatePostSettings(postId, { replyPermission: permission });
                                } catch (e) {
                                    Alert.alert('Error', 'Failed to update reply permissions');
                                }
                            }}
                            quotesDisabled={viewPost?.metadata?.quotesDisabled || false}
                            onQuotesDisabledChange={async (disabled) => {
                                try {
                                    await feedService.updatePostSettings(postId, { quotesDisabled: disabled });
                                } catch (e) {
                                    Alert.alert('Error', 'Failed to update quote settings');
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
            { icon: <TrashIcon size={20} className="text-destructive" />, text: "Delete", onPress: handleDelete, color: theme.colors.error }
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
            try { bottomSheet.openBottomSheet(false); } catch (e) { console.warn('[usePostActions] Failed to close bottom sheet:', e); }
            const userId = viewPost?.user?.id;
            const username = viewPost?.user?.handle || viewPost?.user?.name || 'this user';

            if (!userId) {
                Alert.alert('Error', 'Unable to mute user');
                return;
            }

            const confirmed = await confirmDialog({
                title: `Mute @${username}`,
                message: `You won't see posts from @${username} in your timeline. You can unmute them later from settings.`,
                okText: 'Mute',
                cancelText: 'Cancel',
                destructive: false,
            });

            if (!confirmed) return;

            const success = await muteService.muteUser(userId);
            if (success) {
                Alert.alert('Success', `@${username} has been muted`);
            } else {
                Alert.alert('Error', 'Failed to mute user');
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
                            Alert.alert('Report Submitted', 'Thank you for helping keep our community safe.');
                        } else {
                            Alert.alert('Error', 'Failed to submit report. Please try again.');
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
                text: `Mute @${username}`,
                onPress: handleMuteUser,
            });

            muteReportAction.push({
                icon: <ReportIcon size={20} className="text-destructive" />,
                text: "Report post",
                onPress: handleReportPost,
                color: theme.colors.error,
            });
        }

        const copyLinkAction = [{
            icon: <LinkIcon size={20} className="text-muted-foreground" />,
            text: "Copy link",
            onPress: async () => {
                try {
                    if (Platform.OS === 'web') {
                        await navigator.clipboard.writeText(postUrl);
                    } else {
                        const { Clipboard } = require('react-native');
                        Clipboard.setString(postUrl);
                    }
                } catch (e) { console.warn('[usePostActions] Failed to copy link:', e); }
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
    }, [viewPost, isOwner, isSaved, hasArticle, hasSources, onSave, onOpenArticle, onOpenSources, theme, t, bottomSheet, router, removePostEverywhere]);
}

