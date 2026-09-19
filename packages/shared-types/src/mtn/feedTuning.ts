/**
 * Per-user For You feed tuning (Phase 4B).
 *
 * The Mention-local overrides a viewer applies to their OWN For You discovery
 * gate. Stored on the Mention `UserSettings` document (NOT Oxy — this is
 * feed-behavior tuning, not identity/account data) and loaded into the feed
 * request context by `loadViewerFeedContext`. The For You discovery-gate filter
 * modules read their EFFECTIVE params as `feedTuning.forYou` merged OVER the
 * `MtnConfig.feed.discoveryGate` defaults, so the default gate still applies
 * unless a viewer explicitly disables or re-tunes a module.
 *
 * "One predicate, three consumers": the SAME filter predicates power (a) a
 * custom-feed author's static params, (b) the For You config-default gate, and
 * (c) these per-user overrides — nothing is re-implemented per surface.
 */

/**
 * A single tunable For You gate module. `enabled` toggles the module for THIS
 * viewer (absent ⇒ the config default, which is "on" for the default gate
 * modules). The numeric `threshold` overrides the module's config-default
 * threshold; absent ⇒ the config default. Each concrete module below fixes the
 * threshold's key so the shape stays strict and self-documenting.
 */
export interface ForYouFeedTuning {
  /** Crude minimum `content.text` length floor (`discoveryGate.minTextLength`). */
  minLength?: { enabled?: boolean; minLength?: number };
  /** Emoji/shortcode-only + trusted spam/quality low-effort gate. */
  lowEffortGate?: { enabled?: boolean; minMeaningfulTextLength?: number };
  /** Native-engagement-or-interest-match gate. */
  nativeEngagement?: { enabled?: boolean; minNativeEngagement?: number };
  /**
   * Trusted-quality floor. NEUTRAL by default (no threshold ⇒ keeps everything);
   * a viewer opts in by setting a `minQuality` threshold in [0, 1].
   */
  minQuality?: { enabled?: boolean; minQuality?: number };
  /**
   * Whether recommendation surfaces withhold posts carrying a content warning
   * from authors the reader does not follow. A TOGGLE, with no threshold — there
   * is no dial between "warned" and "not warned".
   */
  noContentWarning?: { enabled?: boolean };
}

/** The root feed-tuning subdocument. Only For You is tunable today. */
export interface FeedTuning {
  forYou?: ForYouFeedTuning;
}

/** UI control type for a tunable param (mirrors the module-catalog param types). */
export type ForYouTuningControl = 'boolean' | 'number-range';

/**
 * The declarative spec for one tunable For You gate module — the SINGLE source of
 * truth for (a) validating an inbound `feedTuning.forYou` payload (bounds +
 * shape) and (b) the module-catalog param descriptors the settings UI renders.
 * `moduleId` matches both the gate {@link ForYouFeedTuning} key and the registered
 * filter-module id, so a settings screen can key its controls off the catalog.
 */
interface ForYouTuningModuleSpecBase {
  /** Gate module id (also the `ForYouFeedTuning` key). */
  moduleId: keyof ForYouFeedTuning;
  /**
   * Whether the module is ON by default in the For You gate. `minQuality` is
   * opt-in (default OFF / neutral); the rest ship on (in shadow mode).
   */
  defaultEnabled: boolean;
  /** Category grouping for the settings UI. */
  category: 'quality' | 'engagement' | 'content' | 'safety';
  /** i18n label key base — the UI resolves `${labelKey}` and `${labelKey}` + status. */
  labelKey: string;
  descriptionKey: string;
}

/**
 * The declarative spec for one tunable For You gate module, discriminated by the
 * CONTROL its setting needs.
 *
 * {@link ForYouTuningControl} was declared from the start and went unused for as
 * long as every gate module happened to have a numeric threshold. It stops being
 * decorative here: a module can be a pure toggle, and the discriminant is what
 * keeps `paramKey`/`min`/`max`/`step` from being four fields a toggle has to
 * invent values for — values the validator would then enforce and the settings
 * screen would then render a meaningless slider from.
 */
export type ForYouTuningModuleSpec =
  | (ForYouTuningModuleSpecBase & {
    control: 'number-range';
    /** Numeric threshold param key on this module's tuning entry. */
    paramKey: string;
    /** Inclusive bounds + granularity for the threshold control. */
    min: number;
    max: number;
    step: number;
  })
  | (ForYouTuningModuleSpecBase & { control: 'boolean' });

/** The four tunable For You discovery-gate modules and their bounds. */
export const FOR_YOU_TUNING_MODULES: readonly ForYouTuningModuleSpec[] = [
  {
    moduleId: 'minLength',
    control: 'number-range',
    paramKey: 'minLength',
    min: 0,
    max: 500,
    step: 1,
    defaultEnabled: true,
    category: 'content',
    labelKey: 'feed.tuning.minLength.label',
    descriptionKey: 'feed.tuning.minLength.description',
  },
  {
    moduleId: 'lowEffortGate',
    control: 'number-range',
    paramKey: 'minMeaningfulTextLength',
    min: 0,
    max: 200,
    step: 1,
    defaultEnabled: true,
    category: 'quality',
    labelKey: 'feed.tuning.lowEffortGate.label',
    descriptionKey: 'feed.tuning.lowEffortGate.description',
  },
  {
    moduleId: 'nativeEngagement',
    control: 'number-range',
    paramKey: 'minNativeEngagement',
    min: 0,
    max: 50,
    step: 1,
    defaultEnabled: true,
    category: 'engagement',
    labelKey: 'feed.tuning.nativeEngagement.label',
    descriptionKey: 'feed.tuning.nativeEngagement.description',
  },
  {
    moduleId: 'minQuality',
    control: 'number-range',
    paramKey: 'minQuality',
    min: 0,
    max: 1,
    step: 0.05,
    defaultEnabled: false,
    category: 'quality',
    labelKey: 'feed.tuning.minQuality.label',
    descriptionKey: 'feed.tuning.minQuality.description',
  },
  {
    moduleId: 'noContentWarning',
    control: 'boolean',
    defaultEnabled: true,
    category: 'safety',
    labelKey: 'feed.tuning.noContentWarning.label',
    descriptionKey: 'feed.tuning.noContentWarning.description',
  },
];

/** A discriminated validation result for {@link validateForYouTuning}. */
export type ForYouTuningValidation =
  | { valid: true; value: ForYouFeedTuning }
  | { valid: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate + normalize an inbound `feedTuning.forYou` payload against
 * {@link FOR_YOU_TUNING_MODULES}. Rejects unknown module keys, unknown param
 * keys, non-boolean `enabled`, and out-of-range / non-finite thresholds. Returns
 * a clean object carrying ONLY the recognized, in-range values (no
 * mass-assignment) so the caller can persist it verbatim.
 */
export function validateForYouTuning(input: unknown): ForYouTuningValidation {
  if (input === undefined || input === null) {
    return { valid: true, value: {} };
  }
  if (!isPlainObject(input)) {
    return { valid: false, error: 'forYou tuning must be an object' };
  }

  const specById = new Map(FOR_YOU_TUNING_MODULES.map((spec) => [spec.moduleId, spec]));
  const value: ForYouFeedTuning = {};

  for (const [moduleId, rawEntry] of Object.entries(input)) {
    const spec = specById.get(moduleId as keyof ForYouFeedTuning);
    if (!spec) {
      return { valid: false, error: `Unknown For You tuning module: "${moduleId}"` };
    }
    if (!isPlainObject(rawEntry)) {
      return { valid: false, error: `Tuning for "${moduleId}" must be an object` };
    }

    const entry: { enabled?: boolean; [k: string]: boolean | number | undefined } = {};

    for (const [key, raw] of Object.entries(rawEntry)) {
      if (key === 'enabled') {
        if (typeof raw !== 'boolean') {
          return { valid: false, error: `"${moduleId}.enabled" must be a boolean` };
        }
        entry.enabled = raw;
        continue;
      }
      // A toggle-only module has no threshold, so anything past `enabled` is an
      // unknown param — rejected here rather than dropped, for the same reason the
      // unknown-module and unknown-param branches reject: a payload that is quietly
      // half-applied is worse than one that is refused.
      if (spec.control === 'boolean') {
        return { valid: false, error: `Unknown param "${key}" for tuning module "${moduleId}"` };
      }
      if (key === spec.paramKey) {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          return { valid: false, error: `"${moduleId}.${key}" must be a finite number` };
        }
        if (raw < spec.min || raw > spec.max) {
          return {
            valid: false,
            error: `"${moduleId}.${key}" must be within [${spec.min}, ${spec.max}]`,
          };
        }
        entry[key] = raw;
        continue;
      }
      return { valid: false, error: `Unknown param "${key}" for tuning module "${moduleId}"` };
    }

    value[spec.moduleId] = entry;
  }

  return { valid: true, value };
}
