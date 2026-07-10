/**
 * Custom-feed → runnable FeedDefinition resolution.
 *
 * A stored `CustomFeed` carries a composable `definition` (Phase 3). This module
 * turns a loaded feed document into a full {@link FeedDefinition} the engine can
 * run — attaching the `id`/`title` and an {@link FeedExecution} profile — and
 * loads + access-checks a feed by id for `resolveDefinition('custom|<id>')`.
 *
 * For feeds not yet touched by the one-shot migration (the pre-backfill window)
 * it falls back to deriving the definition from the legacy fields via the SAME
 * {@link legacyCustomFeedToDefinition} mapper the migration persists, so both
 * paths stay identical and no feed breaks before the backfill runs.
 */

import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';
import CustomFeed, { type ICustomFeed, type StoredFeedDefinition } from '../../../models/CustomFeed';
import type { FeedDefinition, FeedExecution, ModuleRef } from '../engine/types';
import { legacyCustomFeedToDefinition, type LegacyCustomFeedShape } from './legacyCustomFeed';

function enabled(module: string): ModuleRef {
  return { module, enabled: true };
}

/** Strip `onlySensitive` and ensure a safety gate is present. */
function ensureSafetyFilters(filters?: ModuleRef[] | null): ModuleRef[] {
  const stripped = (filters ?? []).filter((f) => f.module !== 'onlySensitive');
  const hasSafety = stripped.some(
    (f) => f.enabled && (f.module === 'safety' || f.module === 'excludeSensitive'),
  );
  return hasSafety ? stripped : [...stripped, enabled('safety')];
}

/** The loaded-feed fields this resolver reads. */
type CustomFeedSource = Pick<ICustomFeed, 'title' | 'isPublic'> &
  LegacyCustomFeedShape & {
    _id: unknown;
    definition?: StoredFeedDefinition;
  };

/** Whether the definition excludes boosts (so boost hydration depth is unneeded). */
function excludesBoosts(def: StoredFeedDefinition): boolean {
  return (def.filters ?? []).some((f) => f.enabled && (f.module === 'noBoosts' || f.module === 'originalOnly'));
}

/**
 * Build the runnable definition for a loaded custom feed. Uses the stored
 * `definition` when present, otherwise derives it from the legacy fields.
 *
 * A custom feed may surface boost posts (empty body), so it hydrates at
 * `maxDepth:1` unless it explicitly excludes boosts (see the boost-hydration
 * gotcha). Ranked feeds bound the merged pool like For You.
 */
export function buildCustomFeedDefinition(feed: CustomFeedSource): FeedDefinition {
  const stored = feed.definition;
  const def: StoredFeedDefinition =
    stored && typeof stored.mode === 'string' ? stored : legacyCustomFeedToDefinition(feed);

  const execution: FeedExecution = {
    threadGrouping: true,
    replyContext: false,
    hydrateMaxDepth: excludesBoosts(def) ? 0 : 1,
    ...(def.mode === 'ranked' ? { maxPool: MtnConfig.feed.candidateSources.maxPool } : {}),
  };

  return {
    id: `custom|${String(feed._id)}`,
    title: feed.title ?? 'Custom feed',
    mode: def.mode,
    sources: def.sources,
    signals: def.signals,
    filters: ensureSafetyFilters(def.filters),
    execution,
  };
}

/**
 * Load a custom feed by id and return its runnable definition, or `null` when the
 * id is invalid, the feed is missing, or the viewer may not see it (private feed
 * not owned by the viewer). The visibility check is the single gate — the owner is
 * the viewer resolved server-side, never a value from the request.
 */
export async function loadCustomFeedDefinition(
  feedId: string | undefined,
  viewerId: string | undefined,
): Promise<FeedDefinition | null> {
  if (!feedId || !mongoose.Types.ObjectId.isValid(feedId)) return null;

  const feed = await CustomFeed.findById(feedId).lean<CustomFeedSource | null>();
  if (!feed) return null;
  if (!feed.isPublic && feed.ownerOxyUserId !== viewerId) return null;

  return buildCustomFeedDefinition(feed);
}
