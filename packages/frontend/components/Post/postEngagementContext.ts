import { createContext, useContext } from 'react';

/** Optional post-route action; feed rows do not subscribe to the panel store or authentication. */
export const PostEngagementContext = createContext<
  ((postId: string, kind: 'likes' | 'boosts') => boolean) | null
>(null);

export function useOpenPostEngagement() {
  return useContext(PostEngagementContext);
}
