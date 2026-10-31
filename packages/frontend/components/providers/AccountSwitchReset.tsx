import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { getUserLanguages } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import { useAppLanguage } from '@/hooks/useAppLanguage';
import { useBloomTheme } from '@oxy.so/bloom/theme';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { usePostsStore } from '@/stores/postsStore';
import { useEntityFollowStore } from '@/stores/entityFollowStore';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import { resetLivePresence } from '@/stores/livePresenceStore';
import { useTrendsStore } from '@/stores/trendsStore';
import { clearFeedScrollOffsets } from '@/stores/feedScrollStore';
import { resetEngagementInvalidation } from '@/stores/engagementInvalidation';
import { resetSafetyInvalidation } from '@/stores/safetyInvalidation';
import {
  noteReaderLanguages,
  resetReaderLanguageInvalidation,
} from '@/stores/readerLanguageInvalidation';
import { resetPendingDocuments } from '@/stores/pendingDocuments';
import { setFeedViewerRequestScope } from '@/services/feedService';
import { searchService } from '@/services/searchService';
import { socketService } from '@/services/socketService';
import { liveRoomRuntimeController } from '@/context/LiveRoomContext';
import { claimViewerCache } from '@/db';
import { viewerCacheId } from '@/lib/viewerQueryKeys';
import { resetRecommendationFiltersViewer } from '@/lib/recommendationFilters';
import { resetCurrentUserPrivacySettingsCache } from '@/hooks/usePrivacySettings';

/**
 * Identity boundary for every account-dependent frontend cache.
 *
 * Replaces the SDK's removed per-button `onBeforeSessionChange` hook — and
 * covers more: it fires for every switch path (sidebar ProfileButton, the
 * unified account dialog, remote-driven switches over the device socket),
 * not just one button.
 *
 * During cold-boot auth restoration, A → logout and direct A → B transitions,
 * descendants stay unmounted. The layout effect first proves that persisted
 * post/feed data belongs to the resolved identity (or wipes it), then clears
 * process-local private state before descendants can mount.
 *
 * `fallback` is what covers the screen for exactly as long as descendants are
 * held back, and it is REQUIRED: this gate sits ABOVE the root layout's own
 * splash branch, so whatever it renders IS the whole screen. Rendering nothing
 * here is what produced a multi-second blank boot — on a returning viewer whose
 * warm access token has expired, the device-secret mint is a real network
 * round-trip, and `isAuthResolved` stays false (so `viewerId` stays null) for
 * its whole duration, bounded only by the SDK's 12s cold-boot deadline. The
 * fallback keeps the boot visual up across that window instead.
 */
export function AccountSwitchReset({
  children,
  fallback,
}: {
  children?: React.ReactNode;
  fallback: React.ReactNode;
}) {
  const { user, isAuthenticated, isAuthResolved } = useAuth();
  const queryClient = useQueryClient();
  const { resetTheme } = useBloomTheme();
  const resetAppearance = useAppearanceStore((state) => state.resetViewerState);
  const prevViewerIdRef = useRef<string | null>(null);

  const userId = user?.id?.trim() || null;
  const viewerId = !isAuthResolved
    ? null
    : isAuthenticated
      ? userId
        ? viewerCacheId(userId)
        : null
      : viewerCacheId(null);

  /*
   * The reader's content languages, from the one place that already knows who
   * is reading.
   *
   * The ACCOUNT's declared locales first (`getUserLanguages` — the same helper
   * the backend reads them with, so a bilingual reader gets both languages
   * ordered first rather than only the one the app happens to be in), with the
   * interface language behind them so a signed-out visitor still gets one.
   * Subscribed, not read once: a signed-out reader changes language without any
   * identity change, and nothing remounts this boundary when they do.
   */
  const appLanguage = useAppLanguage();
  const accountLanguages = useMemo(
    () => (isAuthenticated && user ? getUserLanguages(user) : []),
    [isAuthenticated, user],
  );
  const readerLanguages = useMemo(
    () => [...accountLanguages, appLanguage ?? ''],
    [accountLanguages, appLanguage],
  );

  useEffect(() => {
    useTrendsStore.getState().setReaderLanguages(readerLanguages);
  }, [readerLanguages]);

  /*
   * What the SERVER resolves each post's rendition against (`resolveViewerTag`):
   * the account's languages, in order, for a signed-in reader — the interface
   * language trails them as the lowest rung and follows the account's primary
   * anyway — and the interface language for a signed-out one. A change of it for
   * the same viewer refetches every post already on screen
   * (`stores/readerLanguageInvalidation`).
   */
  const renditionLanguages = useMemo(
    () => (isAuthenticated ? accountLanguages : appLanguage ? [appLanguage] : []),
    [isAuthenticated, accountLanguages, appLanguage],
  );
  useEffect(() => {
    if (viewerId) noteReaderLanguages(viewerId, renditionLanguages);
  }, [viewerId, renditionLanguages]);
  const [readyViewerId, setReadyViewerId] = useState<string | null>(null);

  const clearRuntimeState = useCallback(
    (previousViewerId: string | null | undefined, clearCachedData: boolean) => {
      // Stop the old identity's event stream before invalidating its state.
      socketService.disconnect();
      liveRoomRuntimeController.resetViewerState();

      // `clear()` destroys active queries/mutations and removes every cache key,
      // including legacy keys that predate the viewer-key factory.
      queryClient.clear();
      usePostsStore.getState().resetViewerState({ clearCachedData });
      useEntityFollowStore.getState().reset();
      useExternalEmbedsStore.getState().resetViewerState(previousViewerId ?? undefined);
      useLiveRoomsStore.getState().resetViewerState();
      resetLivePresence();
      useTrendsStore.getState().resetViewerState();
      clearFeedScrollOffsets();
      // The previous viewer's engagements say nothing about the next viewer's
      // lists, and every cache they could have marked stale is gone anyway. The
      // same holds for the safety rules they changed — muted words and the
      // sensitive-content toggle are per-account — and for their languages.
      resetEngagementInvalidation();
      resetSafetyInvalidation();
      resetReaderLanguageInvalidation();
      // Link cards still in flight belong to the previous viewer.
      resetPendingDocuments();

      resetAppearance();
      resetTheme();

      if (previousViewerId) {
        resetRecommendationFiltersViewer(previousViewerId);
        resetCurrentUserPrivacySettingsCache(previousViewerId);
        void searchService.clearSearchHistory(previousViewerId).catch((error: unknown) => {
          logger.warn('Failed to clear search history after account change', { error });
        });
      }
    },
    [queryClient, resetAppearance, resetTheme],
  );

  useLayoutEffect(() => {
    if (!viewerId) {
      setFeedViewerRequestScope(null);
      const previousViewerId = prevViewerIdRef.current;
      if (previousViewerId) {
        if (previousViewerId === viewerCacheId(null)) searchService.invalidateSearchHistory();
        clearRuntimeState(
          previousViewerId === viewerCacheId(null) ? undefined : previousViewerId,
          true,
        );
        prevViewerIdRef.current = null;
      }
      if (readyViewerId !== null) setReadyViewerId(null);
      return;
    }

    const prev = prevViewerIdRef.current;
    // Advance request ownership before the new viewer can render. This drops
    // shared promises from the previous identity even if their transport did
    // not expose cancellation.
    setFeedViewerRequestScope(viewerId);
    const cacheClaim = claimViewerCache(viewerId);
    if (!cacheClaim.trusted) {
      if (readyViewerId !== null) setReadyViewerId(null);
      return;
    }
    const identityChanged = prev !== null && prev !== viewerId;

    if (identityChanged || cacheClaim.reset) {
      if (identityChanged && prev === viewerCacheId(null)) {
        searchService.invalidateSearchHistory();
      }
      // claimViewerCache already replaced persistence atomically. Reset only
      // process-local posts state here so its selector invalidation cannot
      // delete the new viewer-owner marker again.
      const previousPrivateViewerId: string | undefined =
        prev && prev !== viewerCacheId(null)
          ? prev
          : cacheClaim.previousViewerId && cacheClaim.previousViewerId !== viewerCacheId(null)
            ? cacheClaim.previousViewerId
            : undefined;
      clearRuntimeState(previousPrivateViewerId, false);
    }

    prevViewerIdRef.current = viewerId;
    if (readyViewerId !== viewerId) {
      setReadyViewerId(viewerId);
    }
  }, [viewerId, readyViewerId, clearRuntimeState]);

  return viewerId && readyViewerId === viewerId ? children : fallback;
}
