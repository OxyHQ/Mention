import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import type { FeedDescriptor } from '@mention/shared-types/mtn/feedDescriptor';
import {
  type FeedPreferences,
  PRESET_FEEDS,
  savedFeedsOfferedTo,
  type SavedFeed,
} from '@mention/shared-types/mtn/presetFeeds';
import { useAgeProtections } from '@/hooks/useAgeProtections';
import { feedPreferencesService } from '@/services/feedPreferencesService';
import { logger } from '@oxy.so/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { accountCacheWriter } from '@/lib/queryClient';

/**
 * The read-only default layout for anonymous viewers: the non-auth presets in
 * their declared order, pinned per each preset's `defaultPinned`. Signed-in
 * viewers get their merged layout from the server instead.
 */
function anonSavedFeeds(): SavedFeed[] {
  return PRESET_FEEDS.filter((preset) => !preset.requiresAuth).map((preset, index) => ({
    key: preset.id,
    descriptor: preset.descriptor,
    pinned: preset.defaultPinned,
    order: index,
  }));
}

const NO_TITLES: Readonly<Record<string, string>> = {};

/** A feed the caller can pin — either a preset (already saved) or a custom feed. */
interface PinnableFeed {
  key: string;
  descriptor: FeedDescriptor;
}

export interface UseFeedPreferences {
  /** The full saved layout (presets + custom), server order. */
  savedFeeds: SavedFeed[];
  /** The pinned subset, ordered by `order`. */
  pinnedFeeds: SavedFeed[];
  /** Pinned custom feeds' titles by feed id, as the server last answered. */
  customFeedTitles: Readonly<Record<string, string>>;
  /** Whether a given key is currently pinned. */
  isPinned: (key: string) => boolean;
  /** Pin a feed (adds it to the saved layout if not already present). */
  pin: (feed: PinnableFeed) => void;
  /** Unpin a feed (keeps it saved, just off the tab bar). */
  unpin: (key: string) => void;
  /** Reorder the pinned feeds to match the given key order. */
  reorder: (orderedPinnedKeys: string[]) => void;
  isLoading: boolean;
  /** Whether the viewer can persist changes (signed in). */
  canEdit: boolean;
}

/**
 * The viewer's server-persisted feed layout (saved / pinned / ordered feeds).
 *
 * Keyed on the auth identity so the layout reloads when a session resolves on
 * cold boot or an account switches; gated on `canUsePrivateApi` so the private
 * endpoint is never hit while anonymous. Anonymous viewers get a read-only
 * default catalog derived from `PRESET_FEEDS`. Pin / unpin / reorder mutate the
 * layout optimistically, PUT it, then invalidate.
 */
export function useFeedPreferences(): UseFeedPreferences {
  const { user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => viewerQueryKeys.feedPreferences(user?.id), [user?.id]);

  const query = useQuery<FeedPreferences>({
    queryKey,
    enabled: canUsePrivateApi,
    staleTime: 5 * 60 * 1000,
    queryFn: () => feedPreferencesService.get(),
    // The home tab row: kept for this account across restarts, so a returning
    // viewer's first paint shows their tabs instead of shifting the feed down.
    meta: { persist: 'account' },
  });

  // A minor's account is not offered the ranked presets (oxy ADR 0068), so its
  // home tabs open on Following. The server refuses those feeds to it as well.
  //
  // Two lists on purpose. `storedFeeds` is the whole layout and is what every
  // edit is computed from and written back, so pinning a feed never drops the
  // presets this viewer is not shown. `savedFeeds` is what the screens read.
  const { feedProfile } = useAgeProtections();
  const storedFeeds = useMemo<SavedFeed[]>(
    () => query.data?.savedFeeds ?? (canUsePrivateApi ? [] : anonSavedFeeds()),
    [query.data, canUsePrivateApi],
  );
  const savedFeeds = useMemo<SavedFeed[]>(
    () => savedFeedsOfferedTo(storedFeeds, feedProfile),
    [storedFeeds, feedProfile],
  );
  const customFeedTitles = query.data?.customFeedTitles ?? NO_TITLES;

  const mutation = useMutation<
    SavedFeed[],
    Error,
    SavedFeed[],
    { previous: FeedPreferences | undefined }
  >({
    mutationFn: (next) => feedPreferencesService.update(next),
    onMutate: async (next) => {
      // The account this write is for: after the await it may be gone.
      const write = accountCacheWriter(queryClient);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FeedPreferences>(queryKey);
      // A newly pinned custom feed has no title until the refetch below.
      write.setQueryData<FeedPreferences>(queryKey, {
        ...previous,
        savedFeeds: next,
      });
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<FeedPreferences>(queryKey, context.previous);
      }
      logger.warn('Failed to persist feed preferences', { error });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const commit = useCallback(
    (next: SavedFeed[]) => {
      if (!canUsePrivateApi) return;
      mutation.mutate(next);
    },
    [canUsePrivateApi, mutation],
  );

  const pin = useCallback(
    (feed: PinnableFeed) => {
      const existing = storedFeeds.find((f) => f.key === feed.key);
      const next = existing
        ? storedFeeds.map((f) => (f.key === feed.key ? { ...f, pinned: true } : f))
        : [
            ...storedFeeds,
            { key: feed.key, descriptor: feed.descriptor, pinned: true, order: storedFeeds.length },
          ];
      commit(next);
    },
    [storedFeeds, commit],
  );

  const unpin = useCallback(
    (key: string) => {
      commit(storedFeeds.map((f) => (f.key === key ? { ...f, pinned: false } : f)));
    },
    [storedFeeds, commit],
  );

  const reorder = useCallback(
    (orderedPinnedKeys: string[]) => {
      const orderIndex = new Map(orderedPinnedKeys.map((key, index) => [key, index]));
      // Pinned feeds take the requested order; unpinned feeds keep their relative
      // order after them. `order` is a single monotonic sequence across the list.
      const pinnedInOrder = storedFeeds
        .filter((f) => f.pinned && orderIndex.has(f.key))
        .sort((a, b) => (orderIndex.get(a.key) ?? 0) - (orderIndex.get(b.key) ?? 0));
      const rest = storedFeeds.filter((f) => !(f.pinned && orderIndex.has(f.key)));
      const next = [...pinnedInOrder, ...rest].map((f, index) => ({ ...f, order: index }));
      commit(next);
    },
    [storedFeeds, commit],
  );

  const pinnedFeeds = useMemo(
    () => savedFeeds.filter((f) => f.pinned).sort((a, b) => a.order - b.order),
    [savedFeeds],
  );

  const isPinned = useCallback(
    (key: string) => savedFeeds.some((f) => f.key === key && f.pinned),
    [savedFeeds],
  );

  return {
    savedFeeds,
    pinnedFeeds,
    customFeedTitles,
    isPinned,
    pin,
    unpin,
    reorder,
    isLoading: canUsePrivateApi && query.isLoading,
    canEdit: canUsePrivateApi,
  };
}
