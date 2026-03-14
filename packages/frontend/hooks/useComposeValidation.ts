import { useMemo } from 'react';
import { ComposerMediaItem } from '@/utils/composeUtils';

interface Source {
  id: string;
  url?: string;
  title?: string;
}

interface ThreadItem {
  id: string;
  text: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  location: any;
  sources?: Array<{ id: string; url: string; title: string }>;
  article?: { title: string; body: string } | null;
  event?: { name: string; date: string; location?: string; description?: string } | null;
  room?: { roomId: string; title: string; status?: string; topic?: string; host?: string } | null;
  replyPermission?: string;
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  isSensitive?: boolean;
}

interface UseComposeValidationProps {
  postContent: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  location: any;
  hasArticleContent: boolean;
  threadItems: ThreadItem[];
  sources: Source[];
  isPosting: boolean;
}

export const useComposeValidation = ({
  postContent,
  mediaIds,
  pollOptions,
  location,
  hasArticleContent,
  threadItems,
  sources,
  isPosting,
}: UseComposeValidationProps) => {
  // Check if there's any valid post content
  const canPostContent = useMemo(() => {
    return (
      postContent.trim().length > 0 ||
      mediaIds.length > 0 ||
      (pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0)) ||
      location ||
      hasArticleContent ||
      threadItems.some(
        item =>
          item.text.trim().length > 0 ||
          item.mediaIds.length > 0 ||
          (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0)) ||
          item.location ||
          Boolean(item.article && (item.article.title?.trim() || item.article.body?.trim())) ||
          Boolean(item.event && item.event.name?.trim()) ||
          Boolean(item.room && item.room.roomId) ||
          Boolean(item.sources && item.sources.length > 0 && item.sources.some(s => s.url.trim().length > 0))
      )
    );
  }, [postContent, mediaIds, pollOptions, location, hasArticleContent, threadItems]);

  // Check if there are invalid sources
  const hasInvalidSources = useMemo(() => {
    return sources.some(source => {
      const url = source?.url?.trim?.() || '';
      const title = source?.title?.trim?.() || '';
      // Invalid if URL exists but title is empty
      return url.length > 0 && title.length === 0;
    });
  }, [sources]);

  // Check if the post button should be enabled
  const isPostButtonEnabled = useMemo(() => {
    return canPostContent && !isPosting && !hasInvalidSources;
  }, [canPostContent, isPosting, hasInvalidSources]);

  return {
    canPostContent,
    hasInvalidSources,
    isPostButtonEnabled,
  };
};
