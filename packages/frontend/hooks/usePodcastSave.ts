import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@oxy.so/core/logger';
import { getSyraClient } from '@/lib/syraPodcasts';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const logger = createLogger('PodcastSave');

/** Subscriptions change only through this app or Syra itself; a few minutes stale is fine. */
const SUBSCRIPTIONS_STALE_MS = 5 * 60_000;

/**
 * Save (subscribe to) a Syra podcast show from a podcast card.
 *
 * "Saved" is the viewer's Syra subscription — the same library Syra shows —
 * read once per viewer as the whole subscribed-id list and shared by every card
 * on screen, so a feed of twenty podcast posts is one request, not twenty.
 * The toggle is optimistic: the list is updated before the write and restored
 * if Syra refuses it.
 *
 * A signed-out tap opens Oxy sign-in instead of failing on a missing token.
 */
export function usePodcastSave(syraPodcastId: string | undefined): {
  isSaved: boolean;
  toggleSave: () => void;
} {
  const { t } = useTranslation();
  const { user, isAuthenticated, signIn } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = viewerQueryKeys.syraPodcastSubscriptions(user?.id);

  const { data: savedIds } = useQuery({
    queryKey,
    enabled: Boolean(isAuthenticated && syraPodcastId),
    staleTime: SUBSCRIPTIONS_STALE_MS,
    queryFn: async () => {
      const client = await getSyraClient();
      const subscriptions = await client.listPodcastSubscriptions();
      return subscriptions.map((subscription) => subscription.podcast.id);
    },
  });

  const isSaved = Boolean(syraPodcastId && savedIds?.includes(syraPodcastId));

  const mutation = useMutation({
    mutationFn: async ({ id, save }: { id: string; save: boolean }) => {
      const client = await getSyraClient();
      if (save) await client.subscribeToPodcast(id);
      else await client.unsubscribeFromPodcast(id);
    },
    onMutate: async ({ id, save }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<string[]>(queryKey);
      queryClient.setQueryData<string[]>(queryKey, (ids = []) =>
        save ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((existing) => existing !== id),
      );
      return { previous };
    },
    onError: (error, { save }, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
      logger.warn('Podcast save failed', { error, save });
      toast.error(
        save
          ? t('podcast.card.saveError', { defaultValue: "Couldn't save the podcast" })
          : t('podcast.card.unsaveError', { defaultValue: "Couldn't remove the podcast" }),
      );
    },
    onSuccess: (_data, { save }) => {
      if (save) toast.success(t('podcast.card.saved', { defaultValue: 'Saved to your Syra library' }));
    },
  });

  const toggleSave = useCallback(() => {
    if (!syraPodcastId) return;
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    if (mutation.isPending) return;
    mutation.mutate({ id: syraPodcastId, save: !isSaved });
  }, [syraPodcastId, isAuthenticated, signIn, mutation, isSaved]);

  return { isSaved, toggleSave };
}
