import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { show as toast } from '@oxyhq/bloom/toast';
import { ComposerMediaItem, toComposerMediaType } from "@/utils/composeUtils";

export const useMediaManager = () => {
  const { t } = useTranslation();
  const [mediaIds, setMediaIds] = useState<ComposerMediaItem[]>([]);

  const addMedia = useCallback(
    (file: any) => {
      const isImage = file?.contentType?.startsWith?.("image/");
      const isVideo = file?.contentType?.startsWith?.("video/");

      if (!isImage && !isVideo) {
        toast(t("Please select an image or video file"), { type: 'error' });
        return false;
      }

      try {
        const resolvedType = toComposerMediaType(
          isImage ? "image" : "video",
          file?.contentType
        );
        const mediaItem: ComposerMediaItem = { id: file.id, type: resolvedType };
        setMediaIds((prev) => (prev.some((m) => m.id === file.id) ? prev : [...prev, mediaItem]));
        toast(t(isImage ? "Image attached" : "Video attached"), { type: 'success' });
        return true;
      } catch (e: any) {
        toast(e?.message || t("Failed to attach media"), { type: 'error' });
        return false;
      }
    },
    [t]
  );

  const addMultipleMedia = useCallback(
    (files: any[]) => {
      const validFiles = (files || []).filter((f) => {
        const contentType = f?.contentType || "";
        return contentType.startsWith("image/") || contentType.startsWith("video/");
      });

      if (validFiles.length !== (files || []).length) {
        toast(t("Please select only image or video files"), { type: 'error' });
      }

      const mediaItems = validFiles.map((f) => ({
        id: f.id,
        type: toComposerMediaType(
          f.contentType?.startsWith("image/") ? "image" : "video",
          f.contentType
        ),
      }));

      setMediaIds((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newItems = mediaItems.filter((m) => !existingIds.has(m.id));
        return [...prev, ...newItems];
      });

      return mediaItems.length;
    },
    [t]
  );

  const removeMedia = useCallback(
    (mediaId: string) => {
      setMediaIds((prev) => prev.filter((m) => m.id !== mediaId));
      toast(t("Media removed"), { type: 'success' });
    },
    [t]
  );

  const moveMedia = useCallback((mediaId: string, direction: "left" | "right") => {
    setMediaIds((prev) => {
      const index = prev.findIndex((m) => m.id === mediaId);
      if (index === -1) return prev;
      const targetIndex = direction === "left" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const updated = [...prev];
      const [item] = updated.splice(index, 1);
      updated.splice(targetIndex, 0, item);
      return updated;
    });
  }, []);

  const clearMedia = useCallback(() => {
    setMediaIds([]);
  }, []);

  return {
    mediaIds,
    setMediaIds,
    addMedia,
    addMultipleMedia,
    removeMedia,
    moveMedia,
    clearMedia,
  };
};
