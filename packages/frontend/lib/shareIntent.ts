/**
 * Web fallback for the share-intent bridge.
 *
 * On web, the Web Share Target API in `app.config.js` forwards `title`, `text`,
 * and `url` straight to `/compose` as query params, so no JS bridge is needed.
 * This hook is a no-op on web.
 *
 * On native, see `shareIntent.native.ts`.
 */

import type { ImperativeRouter } from 'expo-router';

export interface UseShareIntentRouterArgs {
  router: ImperativeRouter;
  enabled?: boolean;
}

export const useShareIntentRouter = (_args: UseShareIntentRouterArgs): void => {
  // intentionally empty on web
};
