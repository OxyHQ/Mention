import type { ForYouFeedTuning, ForYouTuningModuleSpec } from '@mention/shared-types';

/**
 * Per-module threshold shown by the settings UI when the viewer has NOT stored
 * an explicit value yet. They mirror the server `MtnConfig.feed.discoveryGate`
 * defaults so the slider starts at the value the gate would actually use;
 * `minQuality` is opt-in / neutral by default, so it starts at a sensible
 * quality floor the viewer can adjust once they enable it.
 */
export const FOR_YOU_TUNING_DEFAULT_THRESHOLDS: Record<ForYouTuningModuleSpec['moduleId'], number> = {
  minLength: 3,
  lowEffortGate: 12,
  nativeEngagement: 1,
  minQuality: 0.3,
};

/** A module's effective on/off + threshold, resolved from stored tuning + defaults. */
export interface ResolvedTuning {
  enabled: boolean;
  threshold: number;
}

/**
 * Read a module's effective state from the stored tuning, falling back to the
 * spec's `defaultEnabled` and the default threshold. The exhaustive switch keeps
 * the dynamic threshold key strictly typed against each concrete entry shape — a
 * new tunable module fails to compile here until it is handled.
 */
export function resolveTuning(tuning: ForYouFeedTuning, spec: ForYouTuningModuleSpec): ResolvedTuning {
  const fallback = FOR_YOU_TUNING_DEFAULT_THRESHOLDS[spec.moduleId];
  switch (spec.moduleId) {
    case 'minLength': {
      const entry = tuning.minLength;
      return { enabled: entry?.enabled ?? spec.defaultEnabled, threshold: entry?.minLength ?? fallback };
    }
    case 'lowEffortGate': {
      const entry = tuning.lowEffortGate;
      return { enabled: entry?.enabled ?? spec.defaultEnabled, threshold: entry?.minMeaningfulTextLength ?? fallback };
    }
    case 'nativeEngagement': {
      const entry = tuning.nativeEngagement;
      return { enabled: entry?.enabled ?? spec.defaultEnabled, threshold: entry?.minNativeEngagement ?? fallback };
    }
    case 'minQuality': {
      const entry = tuning.minQuality;
      return { enabled: entry?.enabled ?? spec.defaultEnabled, threshold: entry?.minQuality ?? fallback };
    }
  }
}

/**
 * Produce a new tuning object with the given module's entry replaced. Keeps the
 * threshold key strictly typed per module (same exhaustive-switch guarantee as
 * {@link resolveTuning}); the persisted value always mirrors what the UI shows.
 */
export function updateTuning(
  tuning: ForYouFeedTuning,
  spec: ForYouTuningModuleSpec,
  next: ResolvedTuning,
): ForYouFeedTuning {
  switch (spec.moduleId) {
    case 'minLength':
      return { ...tuning, minLength: { enabled: next.enabled, minLength: next.threshold } };
    case 'lowEffortGate':
      return { ...tuning, lowEffortGate: { enabled: next.enabled, minMeaningfulTextLength: next.threshold } };
    case 'nativeEngagement':
      return { ...tuning, nativeEngagement: { enabled: next.enabled, minNativeEngagement: next.threshold } };
    case 'minQuality':
      return { ...tuning, minQuality: { enabled: next.enabled, minQuality: next.threshold } };
  }
}
