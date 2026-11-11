import { lazy, Suspense, type ErrorInfo } from 'react';
import type { AppShellPanelDefinition } from '@oxy.so/bloom/app-shell';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import type { PostEngagementPanel } from './postEngagementPanels';

const EngagementList = lazy(() => import('./EngagementList'));

/** The outer descriptor keeps the workspace's sizing/order; its children own their screens. */
export function postEngagementGroup(
  host: AppShellPanelDefinition,
  engagement: PostEngagementPanel | undefined,
  close: () => void,
  label: string,
  onError: (error: Error, info: ErrorInfo) => void,
  documentWhenAlone = false,
): AppShellPanelDefinition {
  const { content, navigation, bottomBar, headerActions, scroll, errorBoundary, ...group } = host;
  const destination = engagement?.destination;
  // Authored chrome budget: the anonymous sign-in footer needs more room than a reply composer.
  const minimumHeight = bottomBar ? 368 : 224;
  return {
    ...group,
    testID: host.testID ?? `mention-shell-panels-${host.id}`,
    group: {
      mode: 'split',
      axis: 'vertical',
      flow: 'bounded',
      singlePanelFlow: documentWhenAlone ? 'document' : undefined,
      appearance: 'separated',
      panels: [
        {
          id: host.id,
          testID: `mention-shell-panels-${host.id}-content`,
          content,
          navigation,
          bottomBar,
          headerActions,
          scroll,
          errorBoundary,
          keepMounted: host.keepMounted,
          appearance: host.appearance,
          colorPreset: host.colorPreset,
          span: 1,
          minHeight: minimumHeight,
          resizable: true,
        },
        {
          id: `${host.id}:engagement`,
          testID: `mention-shell-panels-${host.id}-engagement`,
          visible: engagement?.isOpen ?? false,
          span: 1,
          minHeight: minimumHeight,
          errorBoundary: { onError },
          floating: {
            below: 'md',
            whenConstrained: true,
            open: engagement?.isOpen ?? false,
            onOpenChange: (isOpen) => {
              if (!isOpen) close();
            },
            placement: 'bottom',
            label,
          },
          content: destination ? (
            <Suspense fallback={<ListSkeleton count={4} />}>
              <EngagementList
                key={`${destination.postId}:${destination.kind}`}
                postId={destination.postId}
                type={destination.kind}
                onClose={close}
                onNavigate={destination.navigate}
              />
            </Suspense>
          ) : null,
        },
      ],
    },
  };
}
