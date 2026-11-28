// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { PublicPodcastCard } from '@syra.fm/sdk/client';
import { getSyraClient } from '@/lib/syraPodcasts';
import { VisibleReferenceStore } from './VisibleReferenceStore';

/** SDK loading and requests are deferred until cards become visible. */
export const syraPodcastCards = new VisibleReferenceStore<PublicPodcastCard>(
  async (ids, options) => {
    const client = await getSyraClient();
    // A large viewport never exceeds the API's bound. No per-card requests.
    const batches = await Promise.all(
      Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) =>
        client.getPublicPodcastCards(ids.slice(index * 100, (index + 1) * 100), options),
      ),
    );
    return {
      items: batches.flatMap((batch) => batch.items),
      unavailableIds: batches.flatMap((batch) => batch.unavailableIds),
    };
  },
);
