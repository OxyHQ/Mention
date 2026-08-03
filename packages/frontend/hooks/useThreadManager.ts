import { useState, useCallback } from "react";
import {
  mergeMentionData,
  reconcileMentionData,
  type MentionData,
  type MentionTextValue,
} from "@/utils/mentions";
import { ComposerMediaItem } from "@/utils/composeUtils";
import { Source } from "@/hooks/useSourcesManager";
import { ArticleData } from "@/hooks/useArticleManager";
import { EventData } from "@/hooks/useEventManager";
import { RoomAttachmentData } from "@/hooks/useRoomManager";
import type { Draft } from "@/hooks/useDrafts";
import type { ReplyPermission } from "@/components/Compose/ReplySettingsSheet";
import type { AccountNode } from "@oxyhq/core";

/**
 * A thread item as it comes back OUT of a stored draft: the persisted subset,
 * with mentions and media already reconciled into their composer shapes by the
 * draft reader. Narrower than {@link ThreadItem} — a draft never persisted the
 * attachments or the per-item interaction settings.
 */
export interface DraftThreadItem
  extends Omit<Draft['threadItems'][number], 'mediaIds' | 'mentions'> {
  mediaIds: ComposerMediaItem[];
  mentions: MentionData[];
}

export interface ThreadItem {
  id: string;
  text: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  pollTitle: string;
  showPollCreator: boolean;
  location: { latitude: number; longitude: number; address?: string } | null;
  mentions: MentionData[];
  sources: Source[];
  article: ArticleData | null;
  event: EventData | null;
  room: RoomAttachmentData | null;
  attachmentOrder: string[];
  replyPermission: ReplyPermission[];
  reviewReplies: boolean;
  quotesDisabled: boolean;
  isSensitive: boolean;
  /**
   * The account this post is published AS, or `null` for the author themselves.
   *
   * Per ITEM rather than per composer because BEAST mode posts are independent —
   * they share a composer and nothing else — so one of them going out under a
   * channel says nothing about the next. A THREAD is the opposite: its
   * continuations are replies to their predecessor, which a channel post cannot
   * have, so the whole thread stays the author's and this value is never read
   * there.
   *
   * The whole {@link AccountNode} rather than its id, for the same reason the
   * main composer holds one: the value has to survive without a live account
   * query, and a header that could not resolve the id would draw the author's own
   * avatar over a post going out as somebody else.
   */
  publishAs: AccountNode | null;
}

export interface ThreadItemDefaults {
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  isSensitive?: boolean;
}

export const useThreadManager = () => {
  const [threadItems, setThreadItems] = useState<ThreadItem[]>([]);

  const addThread = useCallback((defaults?: ThreadItemDefaults) => {
    const newThread: ThreadItem = {
      id: `thread-${Date.now()}`,
      text: "",
      mediaIds: [],
      pollOptions: [],
      pollTitle: "",
      showPollCreator: false,
      location: null,
      mentions: [],
      sources: [],
      article: null,
      event: null,
      room: null,
      attachmentOrder: [],
      replyPermission: defaults?.replyPermission ?? ["anyone"],
      reviewReplies: defaults?.reviewReplies ?? false,
      quotesDisabled: defaults?.quotesDisabled ?? false,
      isSensitive: defaults?.isSensitive ?? false,
      // A new box is the author's own. The account is a per-post decision, so
      // it is never inherited from the box above — carrying one forward would
      // publish under an identity nobody chose for this post.
      publishAs: null,
    };
    setThreadItems((prev) => [...prev, newThread]);
    return newThread.id;
  }, []);

  const removeThread = useCallback((threadId: string) => {
    setThreadItems((prev) => prev.filter((item) => item.id !== threadId));
  }, []);

  /**
   * Atomically update a thread body's storage text and its post-scoped mention
   * registry. `variantTexts` contains that thread item's other language bodies.
   */
  const updateThreadMentionState = useCallback(
    (
      threadId: string,
      value: MentionTextValue,
      variantTexts: readonly string[] = [],
    ) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                text: value.text,
                mentions: reconcileMentionData(
                  [value.text, ...variantTexts],
                  value.mentions,
                ),
              }
            : item
        )
      );
    },
    []
  );

  /**
   * Reconcile a thread's registry after one of its non-primary language bodies
   * changes. The primary body stays untouched.
   */
  const reconcileThreadMentionState = useCallback(
    (
      threadId: string,
      mentions: readonly MentionData[],
      variantTexts: readonly string[],
    ) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                mentions: reconcileMentionData(
                  [item.text, ...variantTexts],
                  mergeMentionData(item.mentions, mentions),
                ),
              }
            : item
        )
      );
    },
    []
  );

  const addThreadMedia = useCallback(
    (threadId: string, mediaItem: ComposerMediaItem) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                mediaIds: item.mediaIds.some((m) => m.id === mediaItem.id)
                  ? item.mediaIds
                  : [...item.mediaIds, mediaItem],
              }
            : item
        )
      );
    },
    []
  );

  const addThreadMediaMultiple = useCallback(
    (threadId: string, mediaItems: ComposerMediaItem[]) => {
      setThreadItems((prev) =>
        prev.map((item) => {
          if (item.id !== threadId) return item;
          const existingIds = new Set(item.mediaIds.map((m) => m.id));
          const newItems = mediaItems.filter((m) => !existingIds.has(m.id));
          return { ...item, mediaIds: [...item.mediaIds, ...newItems] };
        })
      );
    },
    []
  );

  const removeThreadMedia = useCallback((threadId: string, mediaId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId
          ? { ...item, mediaIds: item.mediaIds.filter((m) => m.id !== mediaId) }
          : item
      )
    );
  }, []);

  const setThreadMediaAlt = useCallback(
    (threadId: string, mediaId: string, alt: string) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                mediaIds: item.mediaIds.map((m) =>
                  m.id === mediaId
                    ? { ...m, alt: alt.trim().length > 0 ? alt : undefined }
                    : m
                ),
              }
            : item
        )
      );
    },
    []
  );

  const moveThreadMedia = useCallback(
    (threadId: string, mediaId: string, direction: "left" | "right") => {
      setThreadItems((prev) =>
        prev.map((item) => {
          if (item.id !== threadId) return item;
          const index = item.mediaIds.findIndex((m) => m.id === mediaId);
          if (index === -1) return item;
          const targetIndex = direction === "left" ? index - 1 : index + 1;
          if (targetIndex < 0 || targetIndex >= item.mediaIds.length) return item;
          const updatedMedia = [...item.mediaIds];
          const [mediaItem] = updatedMedia.splice(index, 1);
          updatedMedia.splice(targetIndex, 0, mediaItem);
          return { ...item, mediaIds: updatedMedia };
        })
      );
    },
    []
  );

  const openThreadPollCreator = useCallback((threadId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId
          ? {
              ...item,
              showPollCreator: true,
              pollOptions: item.pollOptions.length === 0 ? ["", ""] : item.pollOptions,
              pollTitle: item.pollTitle || "",
            }
          : item
      )
    );
  }, []);

  const addThreadPollOption = useCallback((threadId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId
          ? { ...item, pollOptions: [...item.pollOptions, ""] }
          : item
      )
    );
  }, []);

  const updateThreadPollOption = useCallback(
    (threadId: string, index: number, value: string) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                pollOptions: item.pollOptions.map((opt, i) =>
                  i === index ? value : opt
                ),
              }
            : item
        )
      );
    },
    []
  );

  const removeThreadPollOption = useCallback(
    (threadId: string, index: number) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId && item.pollOptions.length > 2
            ? {
                ...item,
                pollOptions: item.pollOptions.filter((_, i) => i !== index),
              }
            : item
        )
      );
    },
    []
  );

  const removeThreadPoll = useCallback((threadId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId
          ? {
              ...item,
              showPollCreator: false,
              pollOptions: [],
              pollTitle: "",
            }
          : item
      )
    );
  }, []);

  const updateThreadPollTitle = useCallback(
    (threadId: string, title: string) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId ? { ...item, pollTitle: title } : item
        )
      );
    },
    []
  );

  const setThreadLocation = useCallback(
    (
      threadId: string,
      location: { latitude: number; longitude: number; address?: string } | null
    ) => {
      setThreadItems((prev) =>
        prev.map((item) => (item.id === threadId ? { ...item, location } : item))
      );
    },
    []
  );

  const removeThreadLocation = useCallback((threadId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId ? { ...item, location: null } : item
      )
    );
  }, []);

  // Per-item interaction settings
  const setThreadReplyPermission = useCallback(
    (threadId: string, replyPermission: ReplyPermission[]) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId ? { ...item, replyPermission } : item
        )
      );
    },
    []
  );

  const setThreadReviewReplies = useCallback(
    (threadId: string, reviewReplies: boolean) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId ? { ...item, reviewReplies } : item
        )
      );
    },
    []
  );

  const setThreadQuotesDisabled = useCallback(
    (threadId: string, quotesDisabled: boolean) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId ? { ...item, quotesDisabled } : item
        )
      );
    },
    []
  );

  const setThreadSensitive = useCallback(
    (threadId: string, isSensitive: boolean) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId ? { ...item, isSensitive } : item
        )
      );
    },
    []
  );

  const setThreadPublishAs = useCallback(
    (threadId: string, publishAs: AccountNode | null) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId ? { ...item, publishAs } : item
        )
      );
    },
    []
  );

  // Sources management
  const setThreadSources = useCallback(
    (threadId: string, sources: Source[]) => {
      setThreadItems((prev) =>
        prev.map((item) => (item.id === threadId ? { ...item, sources } : item))
      );
    },
    []
  );

  const addThreadSource = useCallback(
    (threadId: string, source: Source) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? { ...item, sources: [...item.sources, source] }
            : item
        )
      );
    },
    []
  );

  const updateThreadSourceField = useCallback(
    (threadId: string, sourceId: string, field: keyof Source, value: string) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                sources: item.sources.map((s) =>
                  s.id === sourceId ? { ...s, [field]: value } : s
                ),
              }
            : item
        )
      );
    },
    []
  );

  const removeThreadSource = useCallback(
    (threadId: string, sourceId: string) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? { ...item, sources: item.sources.filter((s) => s.id !== sourceId) }
            : item
        )
      );
    },
    []
  );

  // Article management
  const setThreadArticle = useCallback(
    (threadId: string, article: ArticleData | null) => {
      setThreadItems((prev) =>
        prev.map((item) => (item.id === threadId ? { ...item, article } : item))
      );
    },
    []
  );

  const removeThreadArticle = useCallback((threadId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId ? { ...item, article: null } : item
      )
    );
  }, []);

  // Event management
  const setThreadEvent = useCallback(
    (threadId: string, event: EventData | null) => {
      setThreadItems((prev) =>
        prev.map((item) => (item.id === threadId ? { ...item, event } : item))
      );
    },
    []
  );

  const removeThreadEvent = useCallback((threadId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId ? { ...item, event: null } : item
      )
    );
  }, []);

  // Room management
  const setThreadRoom = useCallback(
    (threadId: string, room: RoomAttachmentData | null) => {
      setThreadItems((prev) =>
        prev.map((item) => (item.id === threadId ? { ...item, room } : item))
      );
    },
    []
  );

  const removeThreadRoom = useCallback((threadId: string) => {
    setThreadItems((prev) =>
      prev.map((item) =>
        item.id === threadId ? { ...item, room: null } : item
      )
    );
  }, []);

  // Attachment order management
  const setThreadAttachmentOrder = useCallback(
    (threadId: string, attachmentOrder: string[]) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId ? { ...item, attachmentOrder } : item
        )
      );
    },
    []
  );

  const addThreadAttachment = useCallback(
    (threadId: string, key: string) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId && !item.attachmentOrder.includes(key)
            ? { ...item, attachmentOrder: [...item.attachmentOrder, key] }
            : item
        )
      );
    },
    []
  );

  const removeThreadAttachment = useCallback(
    (threadId: string, key: string) => {
      setThreadItems((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                attachmentOrder: item.attachmentOrder.filter((k) => k !== key),
              }
            : item
        )
      );
    },
    []
  );

  const clearAllThreads = useCallback(() => {
    setThreadItems([]);
  }, []);

  /**
   * Restore thread items from a stored draft. A draft persists only the parts of
   * a thread item the composer can rebuild from — it carries no sources,
   * article, event, room, or per-item interaction settings — so each restored
   * item is completed with the SAME defaults `addThread` uses. Without that, a
   * restored thread item reaches the composer missing `replyPermission` and the
   * sensitive/quote flags entirely.
   */
  const loadThreadsFromDraft = useCallback((threads: DraftThreadItem[]) => {
    setThreadItems(threads.map((thread) => ({
      id: thread.id,
      text: thread.text,
      mediaIds: thread.mediaIds,
      pollOptions: thread.pollOptions,
      pollTitle: thread.pollTitle ?? "",
      showPollCreator: thread.showPollCreator,
      location: thread.location,
      mentions: thread.mentions,
      sources: [],
      article: null,
      event: null,
      room: null,
      attachmentOrder: [],
      replyPermission: ["anyone"],
      reviewReplies: false,
      quotesDisabled: false,
      isSensitive: false,
      // A draft never persisted the author of a box — the account graph can move
      // between the save and the restore, so a stored id could name an account
      // the caller no longer operates. Restoring to the author is the choice that
      // cannot publish under an identity nobody re-confirmed.
      publishAs: null,
    })));
  }, []);

  return {
    threadItems,
    setThreadItems,
    addThread,
    removeThread,
    updateThreadMentionState,
    reconcileThreadMentionState,
    addThreadMedia,
    addThreadMediaMultiple,
    removeThreadMedia,
    moveThreadMedia,
    setThreadMediaAlt,
    openThreadPollCreator,
    addThreadPollOption,
    updateThreadPollOption,
    removeThreadPollOption,
    removeThreadPoll,
    updateThreadPollTitle,
    setThreadLocation,
    removeThreadLocation,
    setThreadSources,
    addThreadSource,
    updateThreadSourceField,
    removeThreadSource,
    setThreadArticle,
    removeThreadArticle,
    setThreadEvent,
    removeThreadEvent,
    setThreadRoom,
    removeThreadRoom,
    setThreadAttachmentOrder,
    addThreadAttachment,
    removeThreadAttachment,
    setThreadReplyPermission,
    setThreadReviewReplies,
    setThreadQuotesDisabled,
    setThreadSensitive,
    setThreadPublishAs,
    clearAllThreads,
    loadThreadsFromDraft,
  };
};
