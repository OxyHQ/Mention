import { useCallback, useMemo, type ReactNode } from 'react';
import type { ReplyDraft } from '@/components/Post/replyDraft';
import { useAuth } from '@oxy.so/services/ui/client';
import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { useFocusEffect, usePathname, useRouter } from '@/lib/navigation/router';
import { usePostEngagementPanels } from './postEngagementPanels';

import {
  PostEngagementContext,
  type PostPanelKind,
  type PostPanelOptions,
} from './postEngagementContext';

/** Captures the post's navigation owner before its supporting panel becomes a sibling. */
export function PostEngagementProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const viewer = user?.id ? `user:${user.id}` : 'anonymous';
  const generation = usePostEngagementPanels((state) => state.generation);
  const hostId = useAppShellPanel().id;
  const route = usePathname();
  const router = useRouter();
  const handleOpen = useCallback(
    (postId: string, kind: PostPanelKind, options?: PostPanelOptions) => {
      if (!hostId) return false;
      usePostEngagementPanels.getState().open(
        viewer,
        generation,
        hostId,
        {
          postId,
          kind,
          route,
          navigate: (href) => router.push(href),
        },
        options?.inlineOnly,
      );
      return true;
    },
    [viewer, generation, hostId, route, router],
  );
  const publishReplies = useCallback(
    (postId: string) => {
      handleOpen(postId, 'replies', { inlineOnly: true });
      const state = usePostEngagementPanels.getState();
      const panel = hostId ? state.panels[hostId] : undefined;
      return state.viewer === viewer &&
        state.generation === generation &&
        panel?.destination.kind === 'replies' &&
        panel.destination.postId === postId &&
        panel.destination.route === route
        ? panel.replyDraft
        : undefined;
    },
    [handleOpen, viewer, generation, hostId, route],
  );
  const closeReplies = useCallback(
    (owner: ReplyDraft) => {
      const state = usePostEngagementPanels.getState();
      const panel = hostId ? state.panels[hostId] : undefined;
      if (hostId && panel?.destination.kind === 'replies' && panel.replyDraft === owner) {
        state.close(viewer, generation, hostId, route);
        // The route keeps its inline slot when a feed has no active video.
        // There is no geometric exit to await; drop this exact payload now.
        state.completeClose(viewer, generation, hostId, panel.destination);
      }
    },
    [viewer, generation, hostId, route],
  );
  const actions = useMemo(
    () => ({ open: handleOpen, publishReplies, closeReplies }),
    [handleOpen, publishReplies, closeReplies],
  );
  useFocusEffect(
    useCallback(() => {
      const state = usePostEngagementPanels.getState();
      const previous = hostId ? state.panels[hostId] : undefined;
      // Videos reserves its replies track on entry, so an old route's closed
      // payload has no outgoing track whose completion could release it.
      if (
        route === '/videos' &&
        hostId &&
        previous &&
        !previous.isOpen &&
        previous.destination.route !== route
      )
        state.completeClose(viewer, generation, hostId, previous.destination);
      return () => {
        if (hostId) usePostEngagementPanels.getState().close(viewer, generation, hostId, route);
      };
    }, [viewer, generation, hostId, route]),
  );
  return (
    <PostEngagementContext.Provider value={actions}>{children}</PostEngagementContext.Provider>
  );
}
