import { useState, useCallback } from "react";
import { MentionData } from "@/components/MentionTextInput";
import { ComposerMediaItem } from "@/utils/composeUtils";

export interface ThreadItem {
  id: string;
  text: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  pollTitle: string;
  showPollCreator: boolean;
  location: { latitude: number; longitude: number; address?: string } | null;
  mentions: MentionData[];
}

export const useThreadManager = () => {
  const [threadItems, setThreadItems] = useState<ThreadItem[]>([]);

  const addThread = useCallback(() => {
    const newThread: ThreadItem = {
      id: `thread-${Date.now()}`,
      text: "",
      mediaIds: [],
      pollOptions: [],
      pollTitle: "",
      showPollCreator: false,
      location: null,
      mentions: [],
    };
    setThreadItems((prev) => [...prev, newThread]);
  }, []);

  const removeThread = useCallback((threadId: string) => {
    setThreadItems((prev) => prev.filter((item) => item.id !== threadId));
  }, []);

  const updateThreadText = useCallback((threadId: string, text: string) => {
    setThreadItems((prev) =>
      prev.map((item) => (item.id === threadId ? { ...item, text } : item))
    );
  }, []);

  const updateThreadMentions = useCallback(
    (threadId: string, mentions: MentionData[]) => {
      setThreadItems((prev) =>
        prev.map((item) => (item.id === threadId ? { ...item, mentions } : item))
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

  const clearAllThreads = useCallback(() => {
    setThreadItems([]);
  }, []);

  const loadThreadsFromDraft = useCallback((threads: ThreadItem[]) => {
    setThreadItems(threads);
  }, []);

  return {
    threadItems,
    setThreadItems,
    addThread,
    removeThread,
    updateThreadText,
    updateThreadMentions,
    addThreadMedia,
    addThreadMediaMultiple,
    removeThreadMedia,
    moveThreadMedia,
    openThreadPollCreator,
    addThreadPollOption,
    updateThreadPollOption,
    removeThreadPollOption,
    removeThreadPoll,
    updateThreadPollTitle,
    setThreadLocation,
    removeThreadLocation,
    clearAllThreads,
    loadThreadsFromDraft,
  };
};
