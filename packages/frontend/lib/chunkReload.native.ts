// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Native no-op for the web-only stale-chunk recovery.
 *
 * Native builds ship a single embedded JS bundle — there are no hashed async
 * route chunks that can go stale, so there is nothing to recover. See
 * `chunkReload.web.ts` for the web implementation.
 */
export function registerChunkErrorRecovery(): void {
  // intentionally empty on native
}

/** Native bundles have no stale web chunks to recover. */
export function recoverChunkError(_error: unknown): void {
  // intentionally empty on native
}
