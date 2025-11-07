import { useState, useEffect, useCallback } from 'react';
import {
  ComposerMediaItem,
  createMediaAttachmentKey,
  getMediaIdFromAttachmentKey,
  isMediaAttachmentKey,
  POLL_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
} from '@/utils/composeUtils';

interface Source {
  id: string;
  url?: string;
  title?: string;
}

interface UseAttachmentOrderProps {
  showPollCreator: boolean;
  hasArticleContent: boolean;
  article: any;
  location: any;
  sources: Source[];
  mediaIds: ComposerMediaItem[];
}

export const useAttachmentOrder = ({
  showPollCreator,
  hasArticleContent,
  article,
  location,
  sources,
  mediaIds,
}: UseAttachmentOrderProps) => {
  const [attachmentOrder, setAttachmentOrder] = useState<string[]>([]);

  // Update attachment order when dependencies change
  useEffect(() => {
    const hasLocationAttachment = Boolean(location);
    const hasSourcesAttachment = sources.some(source => source?.url?.trim?.().length);

    setAttachmentOrder(prev => {
      // Filter out removed attachments
      const filtered = prev.filter((key) => {
        if (key === POLL_ATTACHMENT_KEY) return showPollCreator;
        if (key === ARTICLE_ATTACHMENT_KEY) return hasArticleContent && article;
        if (key === LOCATION_ATTACHMENT_KEY) return hasLocationAttachment;
        if (key === SOURCES_ATTACHMENT_KEY) return hasSourcesAttachment;
        if (isMediaAttachmentKey(key)) {
          const mediaId = getMediaIdFromAttachmentKey(key);
          return mediaIds.some(m => m.id === mediaId);
        }
        return false;
      });

      const next = [...filtered];

      // Add new attachments that aren't in the order yet
      if (showPollCreator && !next.includes(POLL_ATTACHMENT_KEY)) {
        next.push(POLL_ATTACHMENT_KEY);
      }
      if (hasArticleContent && article && !next.includes(ARTICLE_ATTACHMENT_KEY)) {
        next.push(ARTICLE_ATTACHMENT_KEY);
      }
      if (hasLocationAttachment && !next.includes(LOCATION_ATTACHMENT_KEY)) {
        next.push(LOCATION_ATTACHMENT_KEY);
      }
      if (hasSourcesAttachment && !next.includes(SOURCES_ATTACHMENT_KEY)) {
        next.push(SOURCES_ATTACHMENT_KEY);
      }
      mediaIds.forEach((media: ComposerMediaItem) => {
        const key = createMediaAttachmentKey(media.id);
        if (!next.includes(key)) {
          next.push(key);
        }
      });

      return next;
    });
  }, [showPollCreator, hasArticleContent, article, location, sources, mediaIds]);

  // Set the attachment order directly (for draft loading)
  const setOrder = useCallback((order: string[] | ((prev: string[]) => string[])) => {
    if (typeof order === 'function') {
      setAttachmentOrder(order);
    } else {
      setAttachmentOrder(order);
    }
  }, []);

  // Clear all attachments
  const clearOrder = useCallback(() => {
    setAttachmentOrder([]);
  }, []);

  return {
    attachmentOrder,
    setAttachmentOrder: setOrder,
    clearAttachmentOrder: clearOrder,
  };
};
