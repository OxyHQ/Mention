/**
 * Custom-feed builder module catalog — the wire contract for `GET /feed/modules`.
 *
 * The backend derives this catalog from its live module registry (the single
 * source of truth for which modules are `userComposable`) and serves it grouped
 * by kind. The builder renders inputs from each entry's `paramsSchema` and its
 * i18n `labelKey` / `descriptionKey`. These types describe that response shape.
 */

/** The three kinds of module a feed definition composes. */
export type FeedModuleKind = 'source' | 'signal' | 'filter';

/** A single param's shape (a minimal JSON-schema subset the builder understands). */
export interface ModuleParamProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  items?: { type: 'string' | 'number' };
  maxItems?: number;
}

/** The JSON-schema for a module's params object. */
export interface ModuleParamsSchema {
  type: 'object';
  properties: Record<string, ModuleParamProperty>;
  additionalProperties: false;
}

/** One selectable module in the builder catalog. */
export interface ModuleCatalogEntry {
  id: string;
  kind: FeedModuleKind;
  labelKey: string;
  descriptionKey: string;
  paramsSchema: ModuleParamsSchema;
}

/** The full builder catalog, grouped by kind. */
export interface ModuleCatalog {
  sources: ModuleCatalogEntry[];
  signals: ModuleCatalogEntry[];
  filters: ModuleCatalogEntry[];
}
