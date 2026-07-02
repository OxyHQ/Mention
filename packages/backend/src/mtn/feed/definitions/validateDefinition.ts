/**
 * Validation for user-authored custom-feed definitions.
 *
 * A custom feed's {@link StoredFeedDefinition} is user-supplied, so it is
 * validated on every write against the module registry:
 *
 * - `mode` is `ranked` or `chronological`;
 * - every referenced module id is registered with the matching kind;
 * - source + filter modules MUST be `userComposable` (this alone bars every
 *   viewer-relative source — `following`/`mutuals`/`saved`/`authored`/… — so a
 *   custom feed can never target another user; the owner is resolved server-side);
 * - params are plain, primitive-valued, and within per-key caps (accounts ≤ 200,
 *   keywords/hashtags ≤ 50, …);
 * - list sizes are bounded and at least one source is enabled.
 *
 * Returns a discriminated result carrying a NORMALIZED definition whose refs keep
 * only the whitelisted `{ module, enabled, params?, weight? }` keys — never the
 * caller's raw object (no mass-assignment).
 */

import type { StoredFeedDefinition } from '../../../models/CustomFeed';
import type { FeedDefinitionMode, ModuleRef } from '../engine/types';
import { feedModuleRegistry, FeedModuleRegistry } from '../engine/FeedModuleRegistry';

export interface ValidateDefinitionOptions {
  /** Registry to validate against; defaults to the shared, server-populated singleton. */
  registry?: FeedModuleRegistry;
}

export type ValidateDefinitionResult =
  | { valid: true; definition: StoredFeedDefinition }
  | { valid: false; error: string };

const VALID_MODES: readonly FeedDefinitionMode[] = ['ranked', 'chronological'];

/** Upper bounds on the number of module refs in each list. */
const MAX_SOURCES = 20;
const MAX_SIGNALS = 20;
const MAX_FILTERS = 40;

/** Per-key caps on array-valued params; unlisted array params use the default. */
const ARRAY_PARAM_CAPS: Record<string, number> = {
  authorIds: 200,
  excludedIds: 1000,
  keywords: 50,
  hashtags: 50,
  words: 200,
  languages: 20,
  domains: 100,
  instances: 100,
  topics: 100,
  sentiments: 10,
};
const DEFAULT_ARRAY_CAP = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a scalar param value is an allowed primitive. */
function isPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Validate a params object: plain, shallow, primitive-or-primitive-array values,
 * every array within its cap. Returns an error message or `null`.
 */
function validateParams(params: unknown, moduleId: string): string | null {
  if (params === undefined) return null;
  if (!isPlainObject(params)) return `Module "${moduleId}" params must be an object`;

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      const cap = ARRAY_PARAM_CAPS[key] ?? DEFAULT_ARRAY_CAP;
      if (value.length > cap) {
        return `Module "${moduleId}" param "${key}" exceeds the maximum of ${cap} items`;
      }
      if (!value.every((item) => isPrimitive(item))) {
        return `Module "${moduleId}" param "${key}" must contain only primitive values`;
      }
    } else if (value !== null && !isPrimitive(value)) {
      return `Module "${moduleId}" param "${key}" must be a primitive or an array of primitives`;
    }
  }
  return null;
}

/** Kind-specific existence + composability check for a single ref. */
function resolveError(ref: ModuleRef, kind: 'source' | 'signal' | 'filter', registry: FeedModuleRegistry): string | null {
  if (kind === 'source') {
    const module = registry.getSource(ref.module);
    if (!module) return `Unknown source module: "${ref.module}"`;
    if (!module.userComposable) return `Source module "${ref.module}" is not available in custom feeds`;
    return null;
  }
  if (kind === 'filter') {
    const module = registry.getFilter(ref.module);
    if (!module) return `Unknown filter module: "${ref.module}"`;
    if (module.userComposable !== true) return `Filter module "${ref.module}" is not available in custom feeds`;
    return null;
  }
  const module = registry.getSignal(ref.module);
  if (!module) return `Unknown signal module: "${ref.module}"`;
  return null;
}

/**
 * Validate one module list. On success pushes the NORMALIZED refs into `out` and
 * returns `null`; on failure returns the error message.
 */
function validateList(
  raw: unknown,
  kind: 'source' | 'signal' | 'filter',
  max: number,
  registry: FeedModuleRegistry,
  out: ModuleRef[],
): string | null {
  if (!Array.isArray(raw)) return `"${kind}s" must be an array`;
  if (raw.length > max) return `Too many ${kind}s (max ${max})`;

  for (const entry of raw) {
    if (!isPlainObject(entry)) return `Each ${kind} must be an object`;
    const moduleId = entry.module;
    if (typeof moduleId !== 'string' || moduleId.length === 0) return `Each ${kind} needs a module id`;
    if (typeof entry.enabled !== 'boolean') return `Module "${moduleId}" needs an "enabled" boolean`;
    if (entry.weight !== undefined && typeof entry.weight !== 'number') {
      return `Module "${moduleId}" weight must be a number`;
    }

    const ref: ModuleRef = { module: moduleId, enabled: entry.enabled };
    const kindError = resolveError(ref, kind, registry);
    if (kindError) return kindError;

    const paramsError = validateParams(entry.params, moduleId);
    if (paramsError) return paramsError;

    if (isPlainObject(entry.params)) ref.params = entry.params;
    if (typeof entry.weight === 'number') ref.weight = entry.weight;
    out.push(ref);
  }
  return null;
}

/**
 * Validate + normalize a user-supplied custom-feed definition.
 */
export function validateDefinition(input: unknown, opts: ValidateDefinitionOptions = {}): ValidateDefinitionResult {
  const registry = opts.registry ?? feedModuleRegistry;

  if (!isPlainObject(input)) return { valid: false, error: 'Definition must be an object' };

  const mode = input.mode;
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as FeedDefinitionMode)) {
    return { valid: false, error: 'Definition mode must be "ranked" or "chronological"' };
  }

  const sources: ModuleRef[] = [];
  const sourceError = validateList(input.sources, 'source', MAX_SOURCES, registry, sources);
  if (sourceError) return { valid: false, error: sourceError };

  if (!sources.some((ref) => ref.enabled)) {
    return { valid: false, error: 'A feed needs at least one enabled source' };
  }

  const signals: ModuleRef[] = [];
  const signalError = validateList(input.signals, 'signal', MAX_SIGNALS, registry, signals);
  if (signalError) return { valid: false, error: signalError };

  const filters: ModuleRef[] = [];
  const filterError = validateList(input.filters, 'filter', MAX_FILTERS, registry, filters);
  if (filterError) return { valid: false, error: filterError };

  return { valid: true, definition: { mode: mode as FeedDefinitionMode, sources, signals, filters } };
}
