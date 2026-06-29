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
import { useAuth } from '@oxyhq/services';
import { authenticatedClient } from '@/utils/api';
import { createScopedLogger } from '@/lib/logger';
import type {
  EmbedPlayerSource,
  ExternalEmbedPref,
  ExternalEmbedsSettings,
} from '@mention/shared-types';
import type { UserSettingsResponse } from '@/hooks/usePrivacySettings';

const logger = createScopedLogger('externalEmbedsStore');

const CACHE_KEY = '@mention_external_embeds';

// `hydrate` fires twice across the auth transition (`canFetch` false→true). The
// AsyncStorage cache only seeds the initial state, so read it at most once; the
// authoritative server fetch still runs when `canFetch` becomes true.
let cacheRead = false;

interface ExternalEmbedsState {
  prefs: ExternalEmbedsSettings;
  /** True once the first hydrate (cache + optional server fetch) has settled. */
  hydrated: boolean;
  /**
   * Load cached prefs, then — when `canFetch` — overlay the authoritative
   * server value. Safe to call repeatedly; the latest server value wins.
   */
  hydrate: (canFetch: boolean) => Promise<void>;
  /** Optimistically persist a single provider's preference (with rollback). */
  setPref: (source: EmbedPlayerSource, value: ExternalEmbedPref) => Promise<void>;
  /**
   * Optimistically persist several providers at once in a SINGLE request (with
   * rollback). Used by "Enable external media" so accepting consent doesn't fire
   * one PUT per provider.
   */
  setManyPrefs: (patch: ExternalEmbedsSettings) => Promise<void>;
}

export const useExternalEmbedsStore = create<ExternalEmbedsState>((set, get) => ({
  prefs: {},
  hydrated: false,

  async hydrate(canFetch: boolean) {
    // 1. Cache first — fast, offline-safe, and correct for anonymous viewers.
    //    Guarded so the duplicate hydrate on the auth transition doesn't re-read.
    if (!cacheRead) {
      cacheRead = true;
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          set({ prefs: JSON.parse(cached) as ExternalEmbedsSettings });
        }
      } catch (error) {
        logger.debug('Failed to read cached external-embed prefs', { error });
      }
    }

    // 2. Server is authoritative — but only reachable once the private API is up.
    if (!canFetch) {
      set({ hydrated: true });
      return;
    }

    try {
      const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
      const serverPrefs = response.data?.externalEmbeds;
      if (serverPrefs) {
        set({ prefs: serverPrefs, hydrated: true });
        try {
          await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(serverPrefs));
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
    const previous = get().prefs;
    const next: ExternalEmbedsSettings = { ...previous, ...patch };
    set({ prefs: next });

    try {
      await authenticatedClient.put('/profile/settings', { externalEmbeds: patch });
      // Best-effort cache write — it doesn't gate the mutation, so don't await it.
      void AsyncStorage.setItem(CACHE_KEY, JSON.stringify(next)).catch((error) => {
        logger.debug('Failed to cache external-embed prefs', { error });
      });
    } catch (error) {
      logger.error('Failed to persist external-embed prefs', { error });
      set({ prefs: previous });
    }
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
  const { canUsePrivateApi, isAuthResolved } = useAuth();
  const hydrate = useExternalEmbedsStore((state) => state.hydrate);

  useEffect(() => {
    if (!isAuthResolved) return;
    void hydrate(canUsePrivateApi);
  }, [isAuthResolved, canUsePrivateApi, hydrate]);
}
