import { createContext, useContext } from 'react';
import type { VideoReplyDraft } from '@/components/videos/videoReplyDraft';

export type PostPanelKind = 'likes' | 'boosts' | 'insights' | 'replies';
export interface PostPanelOptions {
  /** Publish the active video's inline replies without opening a floating sheet. */
  inlineOnly?: boolean;
  onCommentPosted?: () => void;
}
export type OpenPostPanel = (
  postId: string,
  kind: PostPanelKind,
  options?: PostPanelOptions,
) => boolean;
interface PostPanelActions {
  open: OpenPostPanel;
  publishReplies: (postId: string, onCommentPosted: () => void) => VideoReplyDraft | undefined;
  closeReplies: (owner: VideoReplyDraft) => void;
}

/** One action per host; dispatch adds no per-row panel-state or authentication subscription. */
export const PostEngagementContext = createContext<PostPanelActions | null>(null);

export function useOpenPostEngagement() {
  return useContext(PostEngagementContext)?.open ?? null;
}

export function useVideoRepliesPanel() {
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
