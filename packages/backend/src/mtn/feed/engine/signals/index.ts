/**
 * Signal modules.
 *
 * In Phase 1 signals are DECLARATIVE weight-key metadata: they name the ranking
 * signals a ranked definition uses, each mapping onto a `MtnConfig.ranking`
 * weight key already composed inside `FeedRankingService.calculatePostScore`.
 * The engine forwards ranked definitions to `feedRankingService.rankPosts`
 * unchanged (no per-definition weights → no new scoring code), preserving For You
 * ranking exactly. Per-signal weighting is a Phase 2 concern; these modules make
 * the definitions self-describing and give the custom-feed builder a catalog.
 */

import { feedModuleRegistry, FeedModuleRegistry } from '../FeedModuleRegistry';
import type { SignalModule } from '../types';

/** id → `MtnConfig.ranking` weight key the signal maps onto. */
const SIGNAL_WEIGHT_KEYS: Record<string, string> = {
  engagement: 'engagement',
  recency: 'recency',
  authorRelationship: 'relationship',
  authorAuthority: 'authority',
  personalization: 'personalization',
  quality: 'quality',
  trendingVelocity: 'trending',
  timeOfDay: 'timeOfDay',
  diversity: 'diversity',
};

export const signalModules: SignalModule[] = Object.entries(SIGNAL_WEIGHT_KEYS).map(
  ([id, weightKey]) => ({ id, kind: 'signal', weightKey }),
);

export function registerSignalModules(registry: FeedModuleRegistry = feedModuleRegistry): void {
  for (const module of signalModules) registry.register(module);
}
