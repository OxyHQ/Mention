// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { PostPodcastContent } from '@mention/shared-types/post';

/** Drops every legacy snapshot, including on draft restore and local cache reads. */
export function podcastReference(value: unknown): PostPodcastContent | null {
  if (!value || typeof value !== 'object' || !('syraPodcastId' in value)) return null;
  const id = typeof value.syraPodcastId === 'string' ? value.syraPodcastId.trim() : '';
  return id && id.length <= 256 ? { syraPodcastId: id } : null;
}
