// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { BrowserContext } from '@playwright/test';
import { PROFILE_HANDLE } from './environment';

/** Public profile geometry for synthetic commerce tests; no live identity or feed reads. */
export async function installCommerceProfile(context: BrowserContext) {
  const profile = {
    id: '019e23ee-2d68-7000-8001-000000000079',
    username: PROFILE_HANDLE,
    kind: 'personal',
    name: { displayName: 'Commerce profile fixture' },
    bio: 'Synthetic storefront profile',
  };
  await context.route(`https://api.oxy.so/profiles/username/${PROFILE_HANDLE}**`, (route) =>
    route.fulfill({ json: profile }),
  );
  await context.route('https://api.oxy.so/profiles/resolve?**', (route) =>
    route.fulfill({ json: { success: true, data: profile } }),
  );
  await context.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
}
