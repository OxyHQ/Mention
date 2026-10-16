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
