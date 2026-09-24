import React, { lazy, Suspense, useContext, useEffect, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useCommunityNoteHandlerContext } from '@/context/CommunityNoteHandlersContext';
import { createCommunityNoteSheets } from '@/components/CommunityNotes/useCommunityNoteSheets';
import { showActionMenu } from '@/components/common/ActionMenu';
import { useSafeBack } from '@/hooks/useSafeBack';
import { buildPostMenuActions } from './postMenuActions';
import { currentPost, toggleSave, usePostInteractionsBinding, type BoundPostCommands } from './postInteractions';

const PostSourcesSheet = lazy(() => import('@/components/Post/PostSourcesSheet'));
const PostInsightsSheet = lazy(() => import('@/components/Post/PostInsightsSheet'));

/**
 * Binds the service-backed post commands — the overflow menu, sources,
 * insights and the community-note sheets — into the app's one
 * `PostInteractionsProvider` controller. Mount exactly once, inside the bottom
 * sheet provider: it resolves theme, i18n, the viewer, router, the sheet, the
 * query client and the note handlers ONCE for the app, instead of once per
 * mounted feed row (issue #1103).
 */
export function PostInteractionsBinder() {
    const bind = usePostInteractionsBinding();
    const theme = useTheme();
    const { t } = useTranslation();
    const { user } = useAuth();
    const router = useRouter();
    const safeBack = useSafeBack();
    const bottomSheet = useContext(BottomSheetContext);
    const queryClient = useQueryClient();
    const noteHandlers = useCommunityNoteHandlerContext();
    const viewerId = user?.id;

    const commands = useMemo<BoundPostCommands>(() => {
        const deps = { theme, t, viewerId, router, safeBack, bottomSheet, queryClient };
        const noteSheets = createCommunityNoteSheets({ bottomSheet, router, handlers: noteHandlers });

        const openSources: BoundPostCommands['openSources'] = (sources) => {
            if (sources.length === 0) return;
            const close = () => {
                bottomSheet.setBottomSheetContent(null);
                bottomSheet.openBottomSheet(false);
            };
            bottomSheet.setBottomSheetContent(
                <Suspense fallback={null}>
                    <PostSourcesSheet sources={sources} onClose={close} />
                </Suspense>,
            );
            bottomSheet.openBottomSheet(true);
        };

        return {
            openSources,
            openInsights: (postId) => {
                bottomSheet.setBottomSheetContent(
                    <Suspense fallback={null}>
                        <PostInsightsSheet postId={postId} onClose={() => bottomSheet.openBottomSheet(false)} />
                    </Suspense>,
                );
                bottomSheet.openBottomSheet(true);
            },
            openCommunityNoteAbout: (note) => noteSheets.openAbout(note),
            openMenu: ({ post: rowPost, isPostDetail, source, onOpenArticle }) => {
                const post = currentPost(rowPost);
                const viewerState = post.viewerState;
                const permissions = post.permissions ?? {};
                const isOwner = viewerState?.isOwner ?? false;
                const sources = post.attachments?.sources ?? [];
                const actions = buildPostMenuActions(
                    {
                        viewPost: post,
                        isOwner,
                        isPostDetail,
                        canViewInsights: permissions.canViewInsights ?? isOwner,
                        canStopSharing: permissions.canStopSharing ?? false,
                        isSaved: viewerState?.isSaved ?? false,
                        hasArticle: Boolean(post.attachments?.article),
                        hasSources: sources.length > 0,
                        onSave: () => toggleSave(post, source),
                        onOpenArticle,
                        onOpenSources: () => openSources(sources),
                    },
                    deps,
                );
                // CrowdSource ownership stays where it was: the handlers decide
                // whether the flow is offered at all, and an author never notes
                // their own post.
                const communityNoteAction =
                    noteSheets.canWrite && !isOwner
                        ? [
                              {
                                  icon: <RiTeamLine width={20} height={20} fill={theme.colors.textSecondary} />,
                                  label: t('communityNotes.menu.add', { defaultValue: 'Add community note' }),
                                  onPress: () => noteSheets.openWriteFlow(post),
                              },
                          ]
                        : [];
                showActionMenu({
                    label: t('postActions.title', { defaultValue: 'Post options' }),
                    groups: [
                        actions.insightsAction,
                        actions.saveActionGroup,
                        actions.stopSharingAction,
                        actions.deleteAction,
                        actions.articleAction,
                        actions.sourcesAction,
                        actions.addToListAction,
                        communityNoteAction,
                        actions.muteReportAction,
                        actions.copyLinkAction,
                    ],
                });
            },
        };
    }, [theme, t, viewerId, router, safeBack, bottomSheet, queryClient, noteHandlers]);

    useEffect(() => {
        bind(commands);
        return () => bind(null);
    }, [bind, commands]);

    return null;
}
