// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Native no-op for the web-only back/forward-cache socket release.
 *
 * There is no page lifecycle on native — the app is never frozen into a document
 * cache, and `socketService` already reconnects from its own AppState handler
 * when the app returns to the foreground. See `socketBfcache.web.ts`.
 */
export function registerSocketBfcacheRelease(): () => void {
  return () => undefined;
}
