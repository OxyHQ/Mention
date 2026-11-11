import { lazy, Suspense, type ErrorInfo } from 'react';
import { Screen } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import type { AppShellPanelDefinition } from '@oxy.so/bloom/app-shell';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { PostEngagementProvider } from './PostEngagementProvider';
import { LazyVideoReplies } from '@/components/videos/LazyVideoReplies';
import type { PostEngagementPanel } from './postEngagementPanels';

const EngagementList = lazy(() => import('./EngagementList'));
const PostInsightsSheet = lazy(() => import('./PostInsightsSheet'));

/** The outer descriptor keeps the workspace's sizing/order; its children own their screens. */
export function postEngagementGroup(
  host: AppShellPanelDefinition,
  engagement: PostEngagementPanel | undefined,
  close: () => void,
  dismissFloating: () => void,
  onExitComplete: () => void,
  label: string,
  onError: (error: Error, info: ErrorInfo) => void,
  documentWhenAlone = false,
  videoRoute = false,
): AppShellPanelDefinition {
  const { content, navigation, bottomBar, headerActions, scroll, errorBoundary, ...group } = host;
  const destination =
    videoRoute && engagement?.destination.route !== '/videos' ? undefined : engagement?.destination;
  const videoReplies = videoRoute || destination?.kind === 'replies';
  // Authored chrome budget: the anonymous sign-in footer needs more room than a reply composer.
  const mainMinimumHeight = bottomBar ? 368 : 224;
  return {
    ...group,
    testID: host.testID ?? `mention-shell-panels-${host.id}`,
    group: {
      mode: 'split',
      axis: videoReplies ? 'horizontal' : 'vertical',
      flow: 'bounded',
      singlePanelFlow: documentWhenAlone ? 'document' : undefined,
      appearance: 'separated',
      panels: [
        {
          id: host.id,
          testID: `mention-shell-panels-${host.id}-content`,
          content: navigation ? (
            content
          ) : (
            <PostEngagementProvider>{content}</PostEngagementProvider>
          ),
          navigation: navigation
            ? {
                ...navigation,
                render: (entry, controller) => (
                  <PostEngagementProvider>
                    {navigation.render(entry, controller)}
                  </PostEngagementProvider>
                ),
              }
            : undefined,
          bottomBar,
          headerActions,
          scroll,
          errorBoundary,
          keepMounted: host.keepMounted,
          appearance: host.appearance,
          colorPreset: host.colorPreset,
          span: videoReplies ? 620 : 1,
          minWidth: videoReplies ? 300 : undefined,
          minHeight: mainMinimumHeight,
          resizable: false,
        },
        {
          id: `${host.id}:engagement`,
          testID: `mention-shell-panels-${host.id}-engagement`,
          visible: videoRoute || (engagement?.isOpen ?? false),
          onExitComplete,
          span: videoReplies ? 350 : 1,
          minWidth: videoReplies ? 280 : undefined,
          minHeight: videoReplies ? 224 : 128,
          resizable: false,
          errorBoundary: { onError },
          floating: {
            below: videoReplies ? 990 : 'md',
            whenConstrained: true,
            open: (engagement?.isOpen ?? false) && (engagement?.floatingOpen ?? true),
            onOpenChange: (isOpen) => {
              if (!isOpen) dismissFloating();
            },
            placement: 'bottom',
            label,
          },
          content: destination ? (
            <Suspense fallback={<ListSkeleton count={4} />}>
              {destination.kind === 'replies' ? (
                <LazyVideoReplies
                  key={`replies:${destination.postId}`}
                  postId={destination.postId}
                  onNavigate={destination.navigate}
                  focusComposerNonce={engagement?.focusComposerNonce}
                  draft={engagement?.replyDraft}
                />
              ) : destination.kind === 'insights' ? (
                <PostInsightsSheet
                  key={`insights:${destination.postId}`}
                  postId={destination.postId}
                  onClose={close}
                />
              ) : (
                <EngagementList
                  key={`${destination.postId}:${destination.kind}`}
                  postId={destination.postId}
                  type={destination.kind}
                  onClose={close}
                  onNavigate={destination.navigate}
                />
              )}
            </Suspense>
          ) : videoRoute ? (
            <Screen
              scroll="none"
              testID="video-replies-pending"
              header={<PageHeader title={label} onBack={null} safeArea={false} />}
            />
          ) : null,
        },
      ],
    },
  };
}
