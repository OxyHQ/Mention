// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import {
  lookupMediaCacheRow,
  recordMediaCacheAccess,
  touchMediaCacheAccess,
  type MediaCacheServeRow,
} from '../../../db/federation/mediaCacheRepository';
import { logger } from '../../../utils/logger';

/**
 * Database-side operations for the federated media cache. These are the calls
 * the proxy read-path makes synchronously; they never touch the network and are
 * always safe to run regardless of whether the write side (worker/eviction) is
 * enabled.
 */

/** Minimal projection returned to the proxy for its serve decision. */
export type CacheRow = MediaCacheServeRow;

/** Look up the current cache row for a remote URL. */
export async function lookupCacheRow(remoteUrl: string): Promise<CacheRow | undefined> {
  return lookupMediaCacheRow(remoteUrl);
}

/** Bump `lastAccessedAt` for a cached URL without blocking the response. */
export async function bumpAccess(remoteUrl: string): Promise<void> {
  await touchMediaCacheAccess(remoteUrl).catch((error: unknown) => {
    logger.warn('[MediaCache] Failed to bump lastAccessedAt', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Record activity on a remote URL and ensure a cache attempt is scheduled.
 *
 * Returns whether a fresh attempt was (re)scheduled, for logging/metrics. A
 * failure answers `false` and logs — this is the request path, and the cost of
 * being wrong is one missed enqueue that the next access re-attempts, not a
 * failed response.
 */
export async function recordAccessAndMaybeEnqueue(remoteUrl: string): Promise<boolean> {
  try {
    return await recordMediaCacheAccess(remoteUrl);
  } catch (error: unknown) {
    logger.warn('[MediaCache] Failed to record access on cache entry', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}
