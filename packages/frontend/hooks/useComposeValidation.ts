import { useMemo } from 'react';
import { hasPublishableContent, type ComposeContent } from '@/utils/composeContent';

interface UseComposeValidationProps {
  content: ComposeContent;
  isPosting: boolean;
}

export const useComposeValidation = ({
  content,
  isPosting,
}: UseComposeValidationProps) => {
  const canPostContent = useMemo(() => hasPublishableContent(content), [content]);

  // A source with a URL but no title cannot be published.
  const hasInvalidSources = useMemo(() => {
    return content.sources.some(source => {
      const url = source?.url?.trim?.() || '';
      const title = source?.title?.trim?.() || '';
      return url.length > 0 && title.length === 0;
    });
  }, [content.sources]);

  const isPostButtonEnabled = useMemo(() => {
    return canPostContent && !isPosting && !hasInvalidSources;
  }, [canPostContent, isPosting, hasInvalidSources]);

  return {
    canPostContent,
    hasInvalidSources,
    isPostButtonEnabled,
  };
};
