/**
 * Native bridge for OS share-sheet → compose intent.
 *
 * When the user picks "Mention" from the OS share sheet (iOS/Android), the
 * `expo-share-intent` module surfaces the payload through `useShareIntent`.
 * We map text/URL into the same `?text=&url=` query string the web Share
 * Target API uses, then push `/compose` — so all entry points hit the same
 * parser (`utils/composeIntent.ts`).
 */

import { useEffect } from 'react';
import { useShareIntent } from 'expo-share-intent';
import type { ImperativeRouter } from 'expo-router';

import { logger } from '@/lib/logger';

export interface UseShareIntentRouterArgs {
  router: ImperativeRouter;
  enabled?: boolean;
}

export const useShareIntentRouter = ({
  router,
  enabled = true,
}: UseShareIntentRouterArgs): void => {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent({
    disabled: !enabled,
  });

  useEffect(() => {
    if (error) {
      logger.warn('share-intent error', { error });
    }
  }, [error]);

  useEffect(() => {
    if (!enabled || !hasShareIntent) return;

    const params: Record<string, string> = {};
    const sharedText = shareIntent.text?.trim();
    const sharedUrl = shareIntent.webUrl?.trim();

    if (sharedText) params.text = sharedText;
    if (sharedUrl) params.url = sharedUrl;

    if (Object.keys(params).length === 0) {
      // Likely a media-only share; we don't support media prefill yet (Phase 2).
      resetShareIntent();
      return;
    }

    router.push({ pathname: '/compose', params });
    resetShareIntent();
  }, [enabled, hasShareIntent, shareIntent, resetShareIntent, router]);
};
