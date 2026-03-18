import { useState, useCallback, useMemo, useRef } from 'react';
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
  ROOM_ATTACHMENT_KEY,
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
  hasRoomContent: boolean;
  room: any;
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
  hasRoomContent,
  room,
  location,
  sources,
  mediaIds,
  hasLink,
  setMediaIds,
}: UseAttachmentOrderProps) => {
  // User-specified ordering (from drag-to-reorder or draft loading)
  const [userOrder, setUserOrder] = useState<string[]>([]);

  // Compute the set of currently active attachment keys from props
  const activeKeys = useMemo(() => {
    const keys = new Set<string>();
    if (showPollCreator) keys.add(POLL_ATTACHMENT_KEY);
    if (hasArticleContent && article) keys.add(ARTICLE_ATTACHMENT_KEY);
    if (hasEventContent && event) keys.add(EVENT_ATTACHMENT_KEY);
    if (hasRoomContent && room) keys.add(ROOM_ATTACHMENT_KEY);
    if (location) keys.add(LOCATION_ATTACHMENT_KEY);
    if (sources.some(source => source?.url?.trim?.().length)) keys.add(SOURCES_ATTACHMENT_KEY);
    if (hasLink) keys.add(LINK_ATTACHMENT_KEY);
    mediaIds.forEach((media: ComposerMediaItem) => {
      keys.add(createMediaAttachmentKey(media.id));
    });
    return keys;
  }, [showPollCreator, hasArticleContent, article, hasEventContent, event, hasRoomContent, room, location, sources, mediaIds, hasLink]);

  // Track previous activeKeys to detect additions for stable ordering
  const prevActiveKeysRef = useRef<Set<string>>(activeKeys);
  const stableOrderRef = useRef<string[]>([]);

  // Reconcile: preserve user ordering for known keys, append new keys at the end
  const attachmentOrder = useMemo(() => {
    const prevKeys = prevActiveKeysRef.current;
    const prevStableOrder = stableOrderRef.current;

    // Start from the last known stable order (which includes user reordering)
    // Filter out keys that are no longer active
    const filtered = (userOrder.length > 0 ? userOrder : prevStableOrder).filter(
      key => activeKeys.has(key)
    );

    // Append any newly active keys not already in the order
    const result = [...filtered];
    activeKeys.forEach(key => {
      if (!result.includes(key)) {
        result.push(key);
      }
    });

    // Update refs for next reconciliation
    prevActiveKeysRef.current = activeKeys;
    stableOrderRef.current = result;

    return result;
  }, [activeKeys, userOrder]);

  // Set the attachment order directly (for draft loading)
  const setOrder = useCallback((order: string[] | ((prev: string[]) => string[])) => {
    if (typeof order === 'function') {
      setUserOrder(prev => {
        const next = order(prev);
        stableOrderRef.current = next;
        return next;
      });
    } else {
      stableOrderRef.current = order;
      setUserOrder(order);
    }
  }, []);

  // Clear all attachments
  const clearOrder = useCallback(() => {
    stableOrderRef.current = [];
    setUserOrder([]);
  }, []);

  // Move an attachment left or right in the order
  const moveAttachment = useCallback((attachmentKey: string, direction: 'left' | 'right') => {
    // Work from current computed order
    const current = stableOrderRef.current;
    const index = current.indexOf(attachmentKey);
    if (index === -1) return;
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= current.length) return;

    const updated = [...current];
    const [item] = updated.splice(index, 1);
    updated.splice(targetIndex, 0, item);

    stableOrderRef.current = updated;
    setUserOrder(updated);

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
  }, [setMediaIds]);

  return {
    attachmentOrder,
    setAttachmentOrder: setOrder,
    clearAttachmentOrder: clearOrder,
    moveAttachment,
  };
};
