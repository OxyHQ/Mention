/**
 * External media embed preferences store.
 *
 * Holds the viewer's per-provider tri-state preference (`'show' | 'hide' |
 * undefined`) for inline external players (YouTube, Spotify, GIPHY, …). The
 * preference is owned server-side (`UserSettings.externalEmbeds`, exposed via
 * `GET /profile/settings/me` + `PUT /profile/settings`); this store mirrors it
 * locally so the feed can decide synchronously whether to mount a provider's
 * player, with an AsyncStorage cache so the choice survives cold boots and
 * renders before the network round-trip lands.
 *
 * Mirrors the hydrate-on-auth pattern of {@link useServerAppearanceSync}: the
 * cache is always read; the authoritative server value is fetched only once the
 * private API is usable.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@oxyhq/services/ui/client';
import { authenticatedClient } from '@/utils/api';
import { createLogger } from '@oxyhq/core/logger';
import {
  viewerCacheId,
  viewerStorageKey,
  type ViewerId,
} from '@/lib/viewerQueryKeys';
import { createKeyedAsyncQueue } from '@/lib/keyedAsyncQueue';
import type {
  EmbedPlayerSource,
  ExternalEmbedPref,
  ExternalEmbedsSettings,
} from '@mention/shared-types';
import type { UserSettingsResponse } from '@/hooks/usePrivacySettings';

const logger = createLogger('externalEmbedsStore');

const CACHE_KEY = '@mention_external_embeds:v2';
const LEGACY_CACHE_KEY = '@mention_external_embeds';

let cacheReadForViewer: string | null = null;
let activeViewerId = viewerCacheId(null);
let hydrationGeneration = 0;
const enqueueExternalEmbedsStorage = createKeyedAsyncQueue();

const cacheKeyForViewer = (viewerId: ViewerId) =>
  viewerStorageKey(CACHE_KEY, viewerId);

interface ExternalEmbedsState {
  prefs: ExternalEmbedsSettings;
  /** True once the first hydrate (cache + optional server fetch) has settled. */
  hydrated: boolean;
  /**
   * Load cached prefs, then — when `canFetch` — overlay the authoritative
   * server value. Safe to call repeatedly; the latest server value wins.
   */
  hydrate: (canFetch: boolean, viewerId?: ViewerId) => Promise<void>;
  /** Optimistically persist a single provider's preference (with rollback). */
  setPref: (source: EmbedPlayerSource, value: ExternalEmbedPref) => Promise<void>;
  /**
   * Optimistically persist several providers at once in a SINGLE request (with
   * rollback). Used by "Enable external media" so accepting consent doesn't fire
   * one PUT per provider.
   */
  setManyPrefs: (patch: ExternalEmbedsSettings) => Promise<void>;
  /** Clear synchronous state and invalidate all old-viewer async work. */
  resetViewerState: (viewerId?: ViewerId) => void;
}

export const useExternalEmbedsStore = create<ExternalEmbedsState>((set, get) => ({
  prefs: {},
  hydrated: false,

  async hydrate(canFetch: boolean, viewerId?: ViewerId) {
    const normalizedViewerId = viewerCacheId(viewerId);
    activeViewerId = normalizedViewerId;
    const generation = ++hydrationGeneration;
    const storageKey = cacheKeyForViewer(viewerId);

    // The unscoped v1 key could contain another account's settings. Never read
    // it; remove it opportunistically during the v2 hydration.
    void AsyncStorage.removeItem(LEGACY_CACHE_KEY).catch(() => {});

    // 1. Cache first — fast, offline-safe, and correct for anonymous viewers.
    //    Guarded per viewer so A's one-time read never suppresses B's.
    if (cacheReadForViewer !== normalizedViewerId) {
      cacheReadForViewer = normalizedViewerId;
      try {
        const cached = await enqueueExternalEmbedsStorage(
          normalizedViewerId,
          async () => {
            if (
              generation !== hydrationGeneration ||
              activeViewerId !== normalizedViewerId
            ) return null;
            return AsyncStorage.getItem(storageKey);
          },
        );
        if (
          generation !== hydrationGeneration ||
          activeViewerId !== normalizedViewerId
        ) return;
        if (cached) {
          set({ prefs: JSON.parse(cached) as ExternalEmbedsSettings });
        }
      } catch (error) {
        logger.debug('Failed to read cached external-embed prefs', { error });
      }
    }

    // 2. Server is authoritative — but only reachable once the private API is up.
    if (!canFetch) {
      if (
        generation === hydrationGeneration &&
        activeViewerId === normalizedViewerId
      ) {
        set({ hydrated: true });
      }
      return;
    }

    try {
      const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
      if (
        generation !== hydrationGeneration ||
        activeViewerId !== normalizedViewerId
      ) return;
      const serverPrefs = response.data?.externalEmbeds;
      if (serverPrefs) {
        set({ prefs: serverPrefs, hydrated: true });
        try {
          await enqueueExternalEmbedsStorage(
            normalizedViewerId,
            async () => {
              if (
                generation !== hydrationGeneration ||
                activeViewerId !== normalizedViewerId
              ) return;
              await AsyncStorage.setItem(
                storageKey,
                JSON.stringify(serverPrefs),
              );
            },
          );
        } catch (error) {
          logger.debug('Failed to cache external-embed prefs', { error });
        }
      } else {
        set({ hydrated: true });
      }
    } catch (error) {
      logger.debug('Failed to load external-embed prefs', { error });
      set({ hydrated: true });
    }
  },

  async setPref(source: EmbedPlayerSource, value: ExternalEmbedPref) {
    await get().setManyPrefs({ [source]: value });
  },

  async setManyPrefs(patch: ExternalEmbedsSettings) {
    const generation = hydrationGeneration;
    const viewerId = activeViewerId;
    const storageKey = cacheKeyForViewer(viewerId);
    const previous = get().prefs;
    const next: ExternalEmbedsSettings = { ...previous, ...patch };
    set({ prefs: next });

    try {
      await authenticatedClient.put('/profile/settings', { externalEmbeds: patch });
      if (
        generation !== hydrationGeneration ||
        activeViewerId !== viewerId
      ) return;
      // Best-effort cache write — it doesn't gate the mutation, so don't await it.
      void enqueueExternalEmbedsStorage(viewerId, async () => {
        if (
          generation !== hydrationGeneration ||
          activeViewerId !== viewerId
        ) return;
        await AsyncStorage.setItem(storageKey, JSON.stringify(next));
      }).catch((error) => {
          logger.debug('Failed to cache external-embed prefs', { error });
        });
    } catch (error) {
      if (
        generation !== hydrationGeneration ||
        activeViewerId !== viewerId
      ) return;
      logger.error('Failed to persist external-embed prefs', error);
      set({ prefs: previous });
    }
  },

  resetViewerState(viewerId?: ViewerId) {
    hydrationGeneration += 1;
    cacheReadForViewer = null;
    activeViewerId = viewerCacheId(null);
    set({ prefs: {}, hydrated: false });
    const normalizedViewerId = viewerCacheId(viewerId);
    void enqueueExternalEmbedsStorage(
      normalizedViewerId,
      () => AsyncStorage.removeItem(cacheKeyForViewer(viewerId)),
    ).catch((error) => {
        logger.debug('Failed to remove external-embed cache', { error });
      });
  },
}));

/**
 * Cheap selector for a single provider's preference. `undefined` means "ask on
 * first play" (no explicit choice persisted yet).
 */
export function useEmbedPref(source: EmbedPlayerSource): ExternalEmbedPref | undefined {
  return useExternalEmbedsStore((state) => state.prefs[source]);
}

/**
 * Hydrate the store once on auth resolution. Wired a SINGLE time at the app root
 * (alongside {@link useServerAppearanceSync}); mirrors its gating so the server
 * fetch only fires when the private API is usable, while the cache still loads
 * for anonymous viewers.
 */
export function useHydrateExternalEmbeds(): void {
  const { canUsePrivateApi, isAuthResolved, user } = useAuth();
  const hydrate = useExternalEmbedsStore((state) => state.hydrate);
  const viewerId = user?.id;

  useEffect(() => {
    if (!isAuthResolved) return;
    void hydrate(canUsePrivateApi, viewerId);
  }, [isAuthResolved, canUsePrivateApi, viewerId, hydrate]);
}
