import { useMemo } from 'react';
import { MAX_POST_TEXT_LENGTH } from '@mention/shared-types/post';
import { isValidSourceUrl } from '@/utils/composeUtils';
import type { ComposeVariantsState } from '@/utils/composeVariants';
import { hasPublishableContent, type ComposeContent } from '@/utils/composeContent';

interface UseComposeValidationProps {
  content: ComposeContent;
  isPosting: boolean;
  variants?: ComposeVariantsState;
}

export const useComposeValidation = ({
  content,
  isPosting,
  variants,
}: UseComposeValidationProps) => {
  const canPostContent = useMemo(() => hasPublishableContent(content), [content]);

  const hasInvalidSources = useMemo(
    () =>
      [content.sources, ...content.threadItems.map((item) => item.sources)].some((sources) =>
        sources.some((source) => !isValidSourceUrl(source.url)),
      ),
    [content.sources, content.threadItems],
  );
  const hasOverlongText = useMemo(
    () =>
      content.postContent.trim().length > MAX_POST_TEXT_LENGTH ||
      content.threadItems.some((item) => item.text.trim().length > MAX_POST_TEXT_LENGTH) ||
      Object.values(variants?.entries ?? {}).some((items) =>
        Object.values(items).some((item) => item.text.trim().length > MAX_POST_TEXT_LENGTH),
      ),
    [content.postContent, content.threadItems, variants],
  );
  const isPostButtonEnabled =
    canPostContent && !isPosting && !hasInvalidSources && !hasOverlongText;

  return {
    canPostContent,
    hasInvalidSources,
    hasOverlongText,
    isPostButtonEnabled,
  };
};
