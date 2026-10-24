import { lazy, Suspense, useContext, useEffect, useMemo } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useCommunityNoteHandlerContext } from '@/context/CommunityNoteHandlersContext';
import { createCommunityNoteSheets } from '@/components/CommunityNotes/useCommunityNoteSheets';
import { prefetchFeed } from '@/hooks/useFeedQuery';
import { pinnedPostQueryOptions } from '@/components/Profile/pinnedPostQuery';
import { useOpenInAllo } from '@/hooks/useOpenInAllo';
import { postPermalink } from '@/utils/postPermalink';
import { alloShareLinks } from '@oxy.so/allo-sdk/links';
import { usePostInteractionsBinding, type BoundPostCommands } from './postInteractions';

const PostSourcesSheet = lazy(() => import('@/components/Post/PostSourcesSheet'));
const PostInsightsSheet = lazy(() => import('@/components/Post/PostInsightsSheet'));

/**
 * Binds the service-backed post commands — send in Allo, sources, insights and
 * the community-note sheets — into the app's one
 * `PostInteractionsProvider` controller. Mount exactly once, inside the bottom
 * sheet provider: it resolves i18n, the viewer, router, the sheet, the
 * query client and the note handlers ONCE for the app, instead of once per
 * mounted feed row (issue #1103).
 */
export function PostInteractionsBinder() {
  const bind = usePostInteractionsBinding();
  const { t } = useTranslation();
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const router = useRouter();
  const bottomSheet = useContext(BottomSheetContext);
  const queryClient = useQueryClient();
  const noteHandlers = useCommunityNoteHandlerContext();
  const openInAllo = useOpenInAllo();
  const viewerId = user?.id;

  const commands = useMemo<BoundPostCommands>(() => {
    const noteSheets = createCommunityNoteSheets({ bottomSheet, router, handlers: noteHandlers });
    const requireSession = () => {
      if (canUsePrivateApi) return true;
      toast(
        isAuthenticated
          ? t('postActions.sessionLoading', {
              defaultValue: 'Your session is loading. Try again in a moment.',
            })
          : t('postActions.signInRequired', { defaultValue: 'Sign in to interact with posts.' }),
        { id: 'post-session-required', type: 'info' },
      );
      return false;
    };

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
      requireSession,
      sendInAllo: (postId) =>
        openInAllo(
          alloShareLinks(postPermalink(postId)),
          t('postActions.allo.notInstalled', {
            defaultValue:
              'Allo is not installed. Get Allo to send this post, or continue on the web.',
          }),
        ),
      openSources,
      prefetchProfile: (profileId) => {
        // Only for a resolved viewer: a read started while the session is
        // still landing would be cached under the wrong viewer's key.
        if (!profileId || (isAuthenticated && (!viewerId || !canUsePrivateApi))) return;
        void queryClient.prefetchQuery(pinnedPostQueryOptions(viewerId, profileId));
        prefetchFeed(queryClient, {
          type: 'posts',
          userId: profileId,
          viewerId: isAuthenticated ? viewerId : undefined,
        });
      },
      openInsights: (postId) => {
        bottomSheet.setBottomSheetContent(
          <Suspense fallback={null}>
            <PostInsightsSheet postId={postId} onClose={() => bottomSheet.openBottomSheet(false)} />
          </Suspense>,
        );
        bottomSheet.openBottomSheet(true);
      },
      openCommunityNoteAbout: (note) => noteSheets.openAbout(note),
    };
  }, [
    t,
    viewerId,
    isAuthenticated,
    canUsePrivateApi,
    router,
    bottomSheet,
    queryClient,
    noteHandlers,
    openInAllo,
  ]);

  useEffect(() => {
    bind(commands);
    return () => bind(null);
  }, [bind, commands]);

  return null;
}
