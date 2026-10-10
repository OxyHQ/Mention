import { useState, useCallback, useMemo, useRef } from 'react';
import { moveItem } from '@oxy.so/bloom/hooks';
import {
  type ComposerMediaItem,
  getMediaIdFromAttachmentKey,
  isMediaAttachmentKey,
} from '@/utils/composeUtils';
import { attachmentKeysOf, reconcileAttachmentOrder } from '@/utils/composeContent';
import type { ArticleData } from './useArticleManager';
import type { EventData } from './useEventManager';
import type { LocationData } from './useLocationManager';
import type { PodcastAttachmentData } from './usePodcastManager';
import type { RoomAttachmentData } from './useRoomManager';
import type { Source } from './useSourcesManager';
import type { JobAttachmentData } from './useJobAttachmentManager';

interface UseAttachmentOrderProps {
  showPollCreator: boolean;
  article: ArticleData | null;
  event: EventData | null;
  room: RoomAttachmentData | null;
  podcast: PodcastAttachmentData | null;
  /** ROOT post only — see `useJobAttachmentManager.ts`. */
  job: JobAttachmentData | null;
  location: LocationData | null;
  sources: Source[];
  mediaIds: ComposerMediaItem[];
  /** URLs of the links detected in the post text — one carousel card each. */
  linkUrls: string[];
  setMediaIds?: (updater: (prev: ComposerMediaItem[]) => ComposerMediaItem[]) => void;
}

export const useAttachmentOrder = ({
  showPollCreator,
  article,
  event,
  room,
  podcast,
  job,
  location,
  sources,
  mediaIds,
  linkUrls,
  setMediaIds,
}: UseAttachmentOrderProps) => {
  // User-specified ordering (from drag-to-reorder or draft loading)
  const [userOrder, setUserOrder] = useState<string[]>([]);

  // The keys of the cards this box currently shows — `composeContent` decides.
  const activeKeys = useMemo(
    () =>
      attachmentKeysOf({
        showPollCreator,
        article,
        event,
        room,
        podcast,
        job,
        location,
        sources,
        mediaIds,
        linkUrls,
      }),
    [showPollCreator, article, event, room, podcast, job, location, sources, mediaIds, linkUrls],
  );

  // Preserve the last computed ordering between attachment changes.
  const stableOrderRef = useRef<string[]>([]);

  // Reconcile: preserve user ordering for known keys, append new keys at the end
  const attachmentOrder = useMemo(() => {
    const prevStableOrder = stableOrderRef.current;

    // Start from the last known stable order (which includes user reordering),
    // drop keys that are no longer active and append newly active ones.
    const result = reconcileAttachmentOrder(
      userOrder.length > 0 ? userOrder : prevStableOrder,
      activeKeys,
    );

    // Update refs for next reconciliation
    stableOrderRef.current = result;

    return result;
  }, [activeKeys, userOrder]);

  // Set the attachment order directly (for draft loading)
  const setOrder = useCallback((order: string[] | ((prev: string[]) => string[])) => {
    if (typeof order === 'function') {
      setUserOrder((prev) => {
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
  const moveAttachment = useCallback(
    (attachmentKey: string, direction: 'left' | 'right') => {
      // Work from current computed order
      const current = stableOrderRef.current;
      const index = current.indexOf(attachmentKey);
      if (index === -1) return;
      const targetIndex = direction === 'left' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= current.length) return;

      const updated = moveItem(current, index, targetIndex);

      stableOrderRef.current = updated;
      setUserOrder(updated);

      // Also reorder mediaIds to match the new attachment order
      if (setMediaIds) {
        const newMediaOrderIds = updated
          .filter(isMediaAttachmentKey)
          .map(getMediaIdFromAttachmentKey);

        if (newMediaOrderIds.length > 0) {
          setMediaIds((prevMedia) => {
            const idToMedia = new Map(prevMedia.map((m) => [m.id, m]));
            const reordered: ComposerMediaItem[] = [];
            newMediaOrderIds.forEach((id) => {
              const mediaItem = idToMedia.get(id);
              if (mediaItem) {
                reordered.push(mediaItem);
              }
            });
            prevMedia.forEach((mediaItem) => {
              if (!newMediaOrderIds.includes(mediaItem.id)) {
                reordered.push(mediaItem);
              }
            });
            return reordered;
          });
        }
      }
    },
    [setMediaIds],
  );

  return {
    attachmentOrder,
    setAttachmentOrder: setOrder,
    clearAttachmentOrder: clearOrder,
    moveAttachment,
  };
};
