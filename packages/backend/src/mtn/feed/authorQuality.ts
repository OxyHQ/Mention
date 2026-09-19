/**
 * Author-quality reads for the feed gate.
 *
 * The feed engine judges candidates BEFORE hydration, where a post carries its
 * author's id and nothing else. Everything a rule might want to know about that
 * account — does it have a picture, how old is it, what standing does it have —
 * is Oxy identity state, and it arrives through exactly one door:
 * {@link resolveUserSummaries}, the Redis-backed batch the ranking authority
 * signal already uses. This module is that door.
 *
 * It is deliberately only the door. The predicates that say what an answer MEANS
 * — has a picture, how old, what standing — arrive WITH the rule that reads them
 * and not before: a helper with no caller reads as wired up when it is not, which
 * is the same trap the deleted `FilterModule.clause` was (see `engine/types`).
 *
 * The one shape decision that does live here is that NOT KNOWING is not a
 * verdict, and it is in the return type rather than in a comment.
 */

import { logger } from '../../utils/logger';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import { resolveUserSummaries } from '../../services/PostHydrationService';

/**
 * Resolve author identity for a candidate pool in ONE batch, or `undefined` when
 * the batch could not be resolved at all.
 *
 * The `undefined` is load-bearing and is why this does not simply return an empty
 * map on failure. An empty map is a real, ordinary answer — Oxy resolved the
 * batch and had nothing for anyone in it — and it is indistinguishable, read as a
 * map, from the identity service being down. A filter handed the empty map would
 * see every author "not found" and, if it were written even slightly carelessly,
 * turn an outage into a verdict on every candidate in the feed. Absent means the
 * question could not be asked; empty means it was asked and answered.
 *
 * Never throws either way, so a caller does not have to defend against it twice.
 */
export async function resolveAuthorQuality(
  authorIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, CachedUserSummary> | undefined> {
  const ids = [...new Set(authorIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return new Map();
  try {
    return await resolveUserSummaries(ids);
  } catch (error) {
    logger.warn('[FeedEngine] Failed to resolve author summaries for the feed gate', error);
    return undefined;
  }
}
