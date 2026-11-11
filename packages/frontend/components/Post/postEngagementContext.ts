import { createContext, useContext } from 'react';

export type PostPanelKind = 'likes' | 'boosts' | 'insights';
type OpenPostPanel = (postId: string, kind: PostPanelKind) => boolean;

/** One action per shell host; rows do not subscribe to panel state or authentication. */
export const PostEngagementContext = createContext<OpenPostPanel | null>(null);

export function useOpenPostEngagement() {
  return useContext(PostEngagementContext);
}

/** Direct action and overflow menu share the same host-first dispatch and standalone fallback. */
export function openPostInsights(
  openPanel: OpenPostPanel | null,
  postId: string,
  fallback: (postId: string) => void,
) {
  if (!openPanel?.(postId, 'insights')) fallback(postId);
}
