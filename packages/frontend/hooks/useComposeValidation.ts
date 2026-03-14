import { useMemo } from 'react';
import { ComposerMediaItem } from '@/utils/composeUtils';
import type { ThreadItem } from '@/hooks/useThreadManager';
import { shouldIncludeThreadItem } from '@/utils/postBuilder';

interface Source {
  id: string;
  url?: string;
  title?: string;
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
      threadItems.some(shouldIncludeThreadItem)
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
