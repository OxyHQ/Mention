import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  generateSourceId,
  isValidSourceUrl,
  sanitizeSourcesForSubmit,
} from "@/utils/composeUtils";

export interface Source {
  id: string;
  title: string;
  url: string;
}

export const useSourcesManager = () => {
  const { t } = useTranslation();
  const [sources, setSources] = useState<Source[]>([]);

  const addSource = useCallback(() => {
    setSources((prev) => {
      if (prev.length >= 5) {
        toast.error(
          t("compose.sources.limit", { defaultValue: "You can add up to 5 sources" })
        );
        return prev;
      }
      return [...prev, { id: generateSourceId(), title: "", url: "" }];
    });
  }, [t]);

  const updateSourceField = useCallback(
    (sourceId: string, field: "title" | "url", value: string) => {
      setSources((prev) =>
        prev.map((source) => (source.id === sourceId ? { ...source, [field]: value } : source))
      );
    },
    []
  );

  const removeSource = useCallback((sourceId: string) => {
    setSources((prev) => prev.filter((source) => source.id !== sourceId));
  }, []);

  const clearSources = useCallback(() => {
    setSources([]);
  }, []);

  const getSanitizedSources = useCallback(() => {
    return sanitizeSourcesForSubmit(sources);
  }, [sources]);

  const hasInvalidSources = useCallback(() => {
    return sources.some((source) => source.url.trim().length > 0 && !isValidSourceUrl(source.url));
  }, [sources]);

  return {
    sources,
    setSources,
    addSource,
    updateSourceField,
    removeSource,
    clearSources,
    getSanitizedSources,
    hasInvalidSources,
  };
};
