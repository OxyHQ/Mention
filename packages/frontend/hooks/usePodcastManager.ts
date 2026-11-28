// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useState, useCallback } from 'react';

import type { PostPodcastContent } from '@mention/shared-types/post';
import { podcastReference } from '@/utils/podcastReference';

/** The composer keeps an opaque reference; visible SDK cards own current facts. */
export type PodcastAttachmentData = PostPodcastContent;

export const usePodcastManager = () => {
  const [podcast, setPodcast] = useState<PodcastAttachmentData | null>(null);

  const savePodcast = useCallback((next: PodcastAttachmentData) => {
    setPodcast(podcastReference(next));
  }, []);

  const removePodcast = useCallback(() => {
    setPodcast(null);
  }, []);

  const loadPodcastFromDraft = useCallback((draftPodcast: PodcastAttachmentData | null) => {
    setPodcast(podcastReference(draftPodcast));
  }, []);

  const clearPodcast = useCallback(() => {
    setPodcast(null);
  }, []);

  return {
    podcast,
    setPodcast,
    savePodcast,
    removePodcast,
    loadPodcastFromDraft,
    clearPodcast,
  };
};
