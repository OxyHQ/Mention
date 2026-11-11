import { type ErrorInfo, Suspense, lazy } from 'react';
import type { AppShellPanelDefinition } from '@oxy.so/bloom/app-shell';
import { type PostPaneDestination, postPanelId } from '@/components/Post/postPane';

const EngagementList = lazy(() => import('@/components/Post/EngagementList'));

/**
 * The panel stacked under `hostId`'s: the people who liked or boosted a post. It is a panel like
 * the others (the same surface as a Deck column), under its host on a wide window and a bottom
 * sheet on a narrow one. It stays in the layout while closed, so opening it never remounts the
 * panel above it.
 */
export function postPanePanel(
  hostId: string,
  stack: string,
  destination: PostPaneDestination | undefined,
  /** What the panel showed last: kept in it while it closes, so the exit animates a full panel. */
  retained: PostPaneDestination | undefined,
  close: () => void,
  label: (destination: PostPaneDestination) => string,
  onError: (error: Error, errorInfo: ErrorInfo) => void,
): AppShellPanelDefinition {
  return {
    id: postPanelId(hostId),
    stack,
    visible: destination !== undefined,
    // In a page that scrolls as a document the panel is docked to the window's bottom edge, a share
    // of the window's height within these bounds, and its start edge is the divider; in a column with
    // a height of its own (Deck) it shares that height with the panel above it.
    sticky: true,
    minHeight: 220,
    maxHeight: 640,
    span: 1,
    errorBoundary: { onError },
    floating: {
      below: 'md',
      open: destination !== undefined,
      onOpenChange: (open) => {
        if (!open) close();
      },
      label: destination ? label(destination) : '',
      placement: 'bottom',
    },
    content:
      (destination ?? retained) ? (
        <Suspense fallback={null}>
          <EngagementList
            postId={(destination ?? retained)!.postId}
            type={(destination ?? retained)!.kind}
            onClose={close}
          />
        </Suspense>
      ) : null,
  };
}
