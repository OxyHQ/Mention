import { useCallback, type ReactNode } from 'react';
import { useAuth } from '@oxy.so/services/ui/client';
import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { useFocusEffect, usePathname, useRouter } from '@/lib/navigation/router';
import { usePostEngagementPanels } from './postEngagementPanels';

import { PostEngagementContext } from './postEngagementContext';

/** Captures the post's navigation owner before its supporting panel becomes a sibling. */
export function PostEngagementProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const viewer = user?.id ? `user:${user.id}` : 'anonymous';
  const generation = usePostEngagementPanels((state) => state.generation);
  const hostId = useAppShellPanel().id;
  const route = usePathname();
  const router = useRouter();
  const handleOpen = useCallback(
    (postId: string, kind: 'likes' | 'boosts') => {
      if (!hostId) return false;
      usePostEngagementPanels.getState().open(viewer, generation, hostId, {
        postId,
        kind,
        route,
        navigate: (href) => router.push(href),
      });
      return true;
    },
    [viewer, generation, hostId, route, router],
  );
  useFocusEffect(
    useCallback(
      () => () => {
        if (hostId) usePostEngagementPanels.getState().release(viewer, generation, hostId, route);
      },
      [viewer, generation, hostId, route],
    ),
  );
  return (
    <PostEngagementContext.Provider value={handleOpen}>{children}</PostEngagementContext.Provider>
  );
}
