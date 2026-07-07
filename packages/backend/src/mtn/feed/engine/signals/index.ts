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

/**
 * id → weight key the signal maps onto.
 *
 * The first group are the ALWAYS-ON preset signals composed unconditionally
 * inside `FeedRankingService.calculatePostScore` (their keys map onto
 * `MtnConfig.ranking` blocks; a definition listing them is descriptive only).
 *
 * The second group are the Phase 2b OPT-IN signals: their `weightKey` (identical
 * to the id) is what `FeedEngine` forwards to `rankPosts` as `enabledSignals`, so
 * the scorer fires ONLY when a definition enables it. Config lives under
 * `MtnConfig.ranking.optInSignals.<id>`. They are default-neutral and NOT in any
 * preset's signal set unless `FOR_YOU_PHASE2B_SIGNALS` enables a subset on For You
 * and Videos (see `definitions/presets.ts`).
 */
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
  // Opt-in (Phase 2b) — content signals.
  mediaBoost: 'mediaBoost',
  positivity: 'positivity',
  conversational: 'conversational',
  coldStartBoost: 'coldStartBoost',
  // Opt-in (Phase 2b) — engagement-history signals.
  penalizeSeen: 'penalizeSeen',
  verifiedBoost: 'verifiedBoost',
  dwellTime: 'dwellTime',
  // Opt-in (Phase 2b) — network signals.
  socialProof: 'socialProof',
  reciprocityBoost: 'reciprocityBoost',
  noveltyBoost: 'noveltyBoost',
};

export const signalModules: SignalModule[] = Object.entries(SIGNAL_WEIGHT_KEYS).map(
  ([id, weightKey]) => ({ id, kind: 'signal', weightKey }),
);

export function registerSignalModules(registry: FeedModuleRegistry = feedModuleRegistry): void {
  for (const module of signalModules) registry.register(module);
}
