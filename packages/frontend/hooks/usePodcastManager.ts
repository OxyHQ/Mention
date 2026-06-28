import { useState, useCallback } from "react";

/**
 * The podcast show the composer has attached. Only `syraPodcastId` is sent to the
 * backend (it denormalizes the rest at write time); the other fields are kept
 * locally to render the compose attachment card without a round-trip.
 */
export interface PodcastAttachmentData {
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
}

export const usePodcastManager = () => {
  const [podcast, setPodcast] = useState<PodcastAttachmentData | null>(null);

  const savePodcast = useCallback((next: PodcastAttachmentData) => {
    setPodcast(next);
  }, []);

  const removePodcast = useCallback(() => {
    setPodcast(null);
  }, []);

  const hasContent = useCallback(() => Boolean(podcast?.syraPodcastId), [podcast]);

  const loadPodcastFromDraft = useCallback((draftPodcast: PodcastAttachmentData | null) => {
    setPodcast(draftPodcast);
  }, []);

  const clearPodcast = useCallback(() => {
    setPodcast(null);
  }, []);

  return {
    podcast,
    setPodcast,
    savePodcast,
    removePodcast,
    hasContent,
    loadPodcastFromDraft,
    clearPodcast,
  };
};
