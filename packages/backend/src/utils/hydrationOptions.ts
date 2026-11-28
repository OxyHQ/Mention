// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { HydrationOptions } from '../services/posts/PostHydrationService';
import { createScopedOxyClient } from './oxyHelpers';
import type { OxyClient } from './privacyHelpers';
import { safetyRequesterFor } from './safetyRequester';
import { requestLanguageCandidates } from './viewerLanguage';

/**
 * The options every hydration made for an HTTP request starts from: the
 * request's viewer, who Safety decides for, its scoped Oxy client and the
 * language it asked for. A call site spreads this and adds only what is its own
 * (`maxDepth`, `includeLinkMetadata`, threaded viewer state, ...). A site that
 * already holds the request's scoped client passes it, so the request keeps one
 * client (and whatever that client memoizes).
 */
export function hydrationOptionsFor(
  req: OxyAuthRequest,
  oxyClient: OxyClient | undefined = createScopedOxyClient(req),
): HydrationOptions {
  return {
    viewerId: req.user?.id,
    safetyRequester: safetyRequesterFor(req),
    oxyClient,
    requestLanguages: requestLanguageCandidates(req),
  };
}
