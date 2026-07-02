/**
 * Module catalog for the custom-feed builder.
 *
 * `buildModuleCatalog` derives the list of modules a user may compose into a
 * custom feed directly from the registry (the single source of truth for
 * `userComposable`), grouped by kind, each annotated with i18n label/description
 * keys (resolved on the frontend by convention) and a small JSON-schema for its
 * params (so the builder can render the right inputs + enforce caps client-side).
 *
 * Sources and filters are offered only when `userComposable`; every registered
 * signal is offered (signals are ranking weights, meaningful only in ranked mode).
 * Params schemas are looked up in {@link MODULE_PARAMS_SCHEMAS}; a module with no
 * params gets the empty schema. Keeping the schemas here — keyed by id — avoids
 * bloating every module definition with builder-only metadata.
 */

import type { ModuleKind } from './engine/types';
import { feedModuleRegistry, FeedModuleRegistry } from './engine/FeedModuleRegistry';

/** A single param's shape (a minimal JSON-schema subset the builder understands). */
export interface ParamProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  items?: { type: 'string' | 'number' };
  maxItems?: number;
}

/** The JSON-schema for a module's params object. */
export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamProperty>;
  additionalProperties: false;
}

export interface ModuleCatalogEntry {
  id: string;
  kind: ModuleKind;
  labelKey: string;
  descriptionKey: string;
  paramsSchema: ParamsSchema;
}

export interface ModuleCatalog {
  sources: ModuleCatalogEntry[];
  signals: ModuleCatalogEntry[];
  filters: ModuleCatalogEntry[];
}

const EMPTY_SCHEMA: ParamsSchema = { type: 'object', properties: {}, additionalProperties: false };

/** `array of strings` with a cap — the common param shape. */
function stringArray(maxItems: number): ParamProperty {
  return { type: 'array', items: { type: 'string' }, maxItems };
}

function schema(properties: Record<string, ParamProperty>): ParamsSchema {
  return { type: 'object', properties, additionalProperties: false };
}

/**
 * Per-module params schema. `maxItems` mirror the caps enforced server-side in
 * `validateDefinition`, so the builder can validate before submitting. Modules
 * omitted here take no params (EMPTY_SCHEMA).
 */
export const MODULE_PARAMS_SCHEMAS: Record<string, ParamsSchema> = {
  // Sources
  keywords: schema({ keywords: stringArray(50), hashtags: stringArray(50) }),
  accounts: schema({ authorIds: stringArray(200) }),
  topic: schema({ slug: { type: 'string' } }),
  starterPack: schema({ packId: { type: 'string' } }),
  quotes: schema({ postId: { type: 'string' }, authorIds: stringArray(200) }),
  instance: schema({ domain: { type: 'string' } }),
  links: schema({ domain: { type: 'string' } }),
  moreLikeThis: schema({
    postId: { type: 'string' },
    topics: stringArray(20),
    hashtags: stringArray(20),
    authorId: { type: 'string' },
  }),
  nearby: schema({
    lat: { type: 'number' },
    lng: { type: 'number' },
    radiusKm: { type: 'number' },
  }),

  // Filters
  languagePreference: schema({ languages: stringArray(20) }),
  muteBlock: schema({ excludedIds: stringArray(1000) }),
  recencyWindow: schema({ windowMs: { type: 'number' } }),
  minEngagement: schema({
    minLikes: { type: 'number' },
    minBoosts: { type: 'number' },
    minComments: { type: 'number' },
    minViews: { type: 'number' },
    minShares: { type: 'number' },
  }),
  maxLength: schema({ maxLength: { type: 'number' } }),
  minLength: schema({ minLength: { type: 'number' } }),
  domainAllowlist: schema({ domains: stringArray(100) }),
  domainDenylist: schema({ domains: stringArray(100) }),
  customMuteWords: schema({ words: stringArray(200) }),
  keywordDenylist: schema({ keywords: stringArray(50) }),
  instanceAllowlist: schema({ instances: stringArray(100) }),
  instanceDenylist: schema({ instances: stringArray(100) }),
  topicAllowlist: schema({ topics: stringArray(100) }),
  topicDenylist: schema({ topics: stringArray(100) }),
  sentimentFilter: schema({ sentiments: stringArray(10) }),
  minFollowers: schema({ minFollowers: { type: 'number' } }),
  minAccountAge: schema({ minAgeDays: { type: 'number' } }),
};

/** Whether a registry module should be offered to the custom-feed builder. */
function isComposable(kind: ModuleKind, userComposable: boolean | undefined): boolean {
  if (kind === 'signal') return true; // every ranking signal is selectable in ranked mode
  return userComposable === true;
}

function toEntry(id: string, kind: ModuleKind): ModuleCatalogEntry {
  return {
    id,
    kind,
    labelKey: `feeds.modules.${id}.label`,
    descriptionKey: `feeds.modules.${id}.description`,
    paramsSchema: MODULE_PARAMS_SCHEMAS[id] ?? EMPTY_SCHEMA,
  };
}

/**
 * Build the builder-facing module catalog from a registry (defaults to the
 * shared, server-populated singleton).
 */
export function buildModuleCatalog(registry: FeedModuleRegistry = feedModuleRegistry): ModuleCatalog {
  const catalog: ModuleCatalog = { sources: [], signals: [], filters: [] };

  for (const module of registry.list()) {
    const userComposable = 'userComposable' in module ? module.userComposable : undefined;
    if (!isComposable(module.kind, userComposable)) continue;

    const entry = toEntry(module.id, module.kind);
    if (module.kind === 'source') catalog.sources.push(entry);
    else if (module.kind === 'signal') catalog.signals.push(entry);
    else catalog.filters.push(entry);
  }

  return catalog;
}
