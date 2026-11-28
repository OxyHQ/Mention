// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
