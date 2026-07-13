/**
 * Custom-feed builder module catalog — the wire contract for `GET /feed/modules`.
 *
 * The backend derives this catalog from its live module registry (the single
 * source of truth for which modules are `userComposable`) and serves it grouped
 * by kind. It is DATA-DRIVEN: a UI (the custom-feed builder AND the For You
 * tuning settings screen) renders every control generically from the catalog —
 * adding a module is a single registry + metadata entry, never a hand-edited UI.
 *
 * Each entry carries:
 *  - `category` — a coarse grouping for the UI (quality / media / language / …);
 *  - `labelKey` / `descriptionKey` — i18n keys (resolved on the frontend);
 *  - `label` / `description` — English DEFAULTS (the frontend `t(key,
 *    { defaultValue })` fallback), so the catalog is self-describing without i18n;
 *  - `params` — UI param descriptors (control type + bounds/options/default) the
 *    UI renders inputs from;
 *  - `paramsSchema` — the JSON-schema VALIDATION contract (mirrors the server-side
 *    per-key caps) the builder validates against before submitting.
 */

/** The three kinds of module a feed definition composes. */
export type FeedModuleKind = 'source' | 'signal' | 'filter';

/**
 * Coarse UI grouping for a catalog module. Purely presentational — it lets the
 * builder/settings render modules under sensible headings without hardcoding the
 * module list.
 */
export type ModuleCategory =
  | 'source'
  | 'ranking'
  | 'quality'
  | 'media'
  | 'engagement'
  | 'language'
  | 'topics'
  | 'network'
  | 'authors'
  | 'safety'
  | 'recency';

/** UI control type for a single param (what widget the UI renders). */
export type ModuleParamControl = 'boolean' | 'number-range' | 'enum' | 'multiselect';

/** A selectable option for an `enum` / `multiselect` param. */
export interface ModuleParamOption {
  value: string;
  labelKey: string;
  label: string;
}

/**
 * A UI descriptor for one module param. `control` picks the widget; the optional
 * fields carry that widget's rendering hints:
 *  - `number-range` → `min` / `max` / `step` (+ optional numeric `default`);
 *  - `enum` / `multiselect` → `options` (+ `maxItems` for multiselect);
 *  - `boolean` → no extra fields (an on/off switch).
 * `default` is the value pre-selected when the param is first added.
 */
export interface ModuleParamDescriptor {
  key: string;
  control: ModuleParamControl;
  labelKey: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  options?: ModuleParamOption[];
  maxItems?: number;
  default?: boolean | number | string | readonly string[];
}

/** A single param's shape (a minimal JSON-schema subset the builder validates against). */
export interface ModuleParamProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  items?: { type: 'string' | 'number' };
  maxItems?: number;
}

/** The JSON-schema for a module's params object (server-mirrored validation). */
export interface ModuleParamsSchema {
  type: 'object';
  properties: Record<string, ModuleParamProperty>;
  additionalProperties: false;
}

/** One selectable module in the builder catalog. */
export interface ModuleCatalogEntry {
  id: string;
  kind: FeedModuleKind;
  category: ModuleCategory;
  labelKey: string;
  descriptionKey: string;
  /** English default label — the frontend `t(labelKey, { defaultValue: label })` fallback. */
  label: string;
  /** English default description — the frontend `t(descriptionKey, { defaultValue })` fallback. */
  description: string;
  /** UI param descriptors (control type + bounds/options/default). */
  params: ModuleParamDescriptor[];
  /** JSON-schema validation contract for the params object. */
  paramsSchema: ModuleParamsSchema;
}

/** The full builder catalog, grouped by kind. */
export interface ModuleCatalog {
  sources: ModuleCatalogEntry[];
  signals: ModuleCatalogEntry[];
  filters: ModuleCatalogEntry[];
}
