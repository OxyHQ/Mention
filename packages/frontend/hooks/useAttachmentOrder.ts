import { useState, useEffect, useCallback } from 'react';
import {
  ComposerMediaItem,
  createMediaAttachmentKey,
  getMediaIdFromAttachmentKey,
  isMediaAttachmentKey,
  POLL_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  EVENT_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  LINK_ATTACHMENT_KEY,
  SPACE_ATTACHMENT_KEY,
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
  hasEventContent: boolean;
  event: any;
  hasSpaceContent: boolean;
  space: any;
  location: any;
  sources: Source[];
  mediaIds: ComposerMediaItem[];
  hasLink: boolean;
  setMediaIds?: (updater: (prev: ComposerMediaItem[]) => ComposerMediaItem[]) => void;
}

export const useAttachmentOrder = ({
  showPollCreator,
  hasArticleContent,
  article,
  hasEventContent,
  event,
  hasSpaceContent,
  space,
  location,
  sources,
  mediaIds,
  hasLink,
  setMediaIds,
}: UseAttachmentOrderProps) => {
  const [attachmentOrder, setAttachmentOrder] = useState<string[]>([]);

  // Update attachment order when dependencies change
  useEffect(() => {
    const hasEventAttachment = Boolean(hasEventContent && event);
    const hasSpaceAttachment = Boolean(hasSpaceContent && space);
    const hasLocationAttachment = Boolean(location);
    const hasSourcesAttachment = sources.some(source => source?.url?.trim?.().length);

    setAttachmentOrder(prev => {
      // Filter out removed attachments
      const filtered = prev.filter((key) => {
        if (key === POLL_ATTACHMENT_KEY) return showPollCreator;
        if (key === ARTICLE_ATTACHMENT_KEY) return hasArticleContent && article;
        if (key === EVENT_ATTACHMENT_KEY) return hasEventAttachment;
        if (key === SPACE_ATTACHMENT_KEY) return hasSpaceAttachment;
        if (key === LOCATION_ATTACHMENT_KEY) return hasLocationAttachment;
        if (key === SOURCES_ATTACHMENT_KEY) return hasSourcesAttachment;
        if (key === LINK_ATTACHMENT_KEY) return hasLink;
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
      if (hasEventAttachment && !next.includes(EVENT_ATTACHMENT_KEY)) {
        next.push(EVENT_ATTACHMENT_KEY);
      }
      if (hasSpaceAttachment && !next.includes(SPACE_ATTACHMENT_KEY)) {
        next.push(SPACE_ATTACHMENT_KEY);
      }
      if (hasLocationAttachment && !next.includes(LOCATION_ATTACHMENT_KEY)) {
        next.push(LOCATION_ATTACHMENT_KEY);
      }
      if (hasSourcesAttachment && !next.includes(SOURCES_ATTACHMENT_KEY)) {
        next.push(SOURCES_ATTACHMENT_KEY);
      }
      if (hasLink && !next.includes(LINK_ATTACHMENT_KEY)) {
        next.push(LINK_ATTACHMENT_KEY);
      }
      mediaIds.forEach((media: ComposerMediaItem) => {
        const key = createMediaAttachmentKey(media.id);
        if (!next.includes(key)) {
          next.push(key);
        }
      });

      return next;
    });
  }, [showPollCreator, hasArticleContent, article, hasEventContent, event, hasSpaceContent, space, location, sources, mediaIds, hasLink]);

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

  // Move an attachment left or right in the order
  const moveAttachment = useCallback((attachmentKey: string, direction: 'left' | 'right') => {
    setAttachmentOrder(prev => {
      const index = prev.indexOf(attachmentKey);
      if (index === -1) return prev;
      const targetIndex = direction === 'left' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const updated = [...prev];
      const [item] = updated.splice(index, 1);
      updated.splice(targetIndex, 0, item);

      // Also reorder mediaIds to match the new attachment order
      if (setMediaIds) {
        const newMediaOrderIds = updated
          .filter(isMediaAttachmentKey)
          .map(getMediaIdFromAttachmentKey);

        if (newMediaOrderIds.length > 0) {
          setMediaIds(prevMedia => {
            const idToMedia = new Map(prevMedia.map(m => [m.id, m]));
            const reordered: ComposerMediaItem[] = [];
            newMediaOrderIds.forEach(id => {
              const mediaItem = idToMedia.get(id);
              if (mediaItem) {
                reordered.push(mediaItem);
              }
            });
            prevMedia.forEach(mediaItem => {
              if (!newMediaOrderIds.includes(mediaItem.id)) {
                reordered.push(mediaItem);
              }
            });
            return reordered;
          });
        }
      }

      return updated;
    });
  }, [setMediaIds]);

  return {
    attachmentOrder,
    setAttachmentOrder: setOrder,
    clearAttachmentOrder: clearOrder,
    moveAttachment,
  };
};
