import { createContext, useContext } from 'react';
import type { ReplyDraft } from '@/components/Post/replyDraft';

export type PostPanelKind = 'likes' | 'reposts' | 'insights' | 'replies';
export interface PostPanelOptions {
  /** Publish the active video's inline replies without opening a floating sheet. */
  inlineOnly?: boolean;
}
export type OpenPostPanel = (
  postId: string,
  kind: PostPanelKind,
  options?: PostPanelOptions,
) => boolean;
interface PostPanelActions {
  open: OpenPostPanel;
  publishReplies: (postId: string) => ReplyDraft | undefined;
  closeReplies: (owner: ReplyDraft) => void;
  /**
   * Move this host's open replies to the video now playing, or close them when
   * there is none. Does nothing when replies are not open.
   */
  followReplies: (postId: string | undefined) => void;
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
