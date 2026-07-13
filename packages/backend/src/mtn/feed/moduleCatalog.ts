/**
 * Module catalog for the custom-feed builder AND the For You tuning settings.
 *
 * `buildModuleCatalog` derives the list of modules a user may compose directly
 * from the registry (the single source of truth for `userComposable`), grouped by
 * kind, each annotated with:
 *  - `category` — a coarse UI grouping (quality / media / language / …);
 *  - `labelKey` / `descriptionKey` — i18n keys (resolved on the frontend);
 *  - `label` / `description` — English DEFAULTS (the `t(key, { defaultValue })`
 *    fallback), so the catalog is self-describing;
 *  - `params` — UI param DESCRIPTORS (control type + bounds/options/default) the
 *    builder/settings render generic controls from;
 *  - `paramsSchema` — the JSON-schema VALIDATION contract (mirrors the server-side
 *    caps) the builder validates against before submitting.
 *
 * DATA-DRIVEN: adding a module is a registry entry + one {@link MODULE_METADATA}
 * row — never a hand-edited UI. Sources/filters are offered only when
 * `userComposable`; every registered signal is offered (signals are ranking
 * weights, meaningful only in ranked mode).
 */

import type {
  ModuleCatalog,
  ModuleCatalogEntry,
  ModuleCategory,
  ModuleParamControl,
  ModuleParamDescriptor,
  ModuleParamProperty,
  ModuleParamsSchema,
} from '@mention/shared-types';
import type { ModuleKind } from './engine/types';
import { feedModuleRegistry, FeedModuleRegistry } from './engine/FeedModuleRegistry';

const EMPTY_SCHEMA: ModuleParamsSchema = { type: 'object', properties: {}, additionalProperties: false };

/** `array of strings` with a cap — the common source-param shape. */
function stringArray(maxItems: number): ModuleParamProperty {
  return { type: 'array', items: { type: 'string' }, maxItems };
}

function schema(properties: Record<string, ModuleParamProperty>): ModuleParamsSchema {
  return { type: 'object', properties, additionalProperties: false };
}

/**
 * Per-module params JSON-SCHEMA. `maxItems` mirror the caps enforced server-side
 * in `validateDefinition`, so the builder can validate before submitting. Modules
 * omitted here take no params (EMPTY_SCHEMA). This is the VALIDATION contract;
 * {@link MODULE_METADATA} carries the parallel UI descriptors.
 */
export const MODULE_PARAMS_SCHEMAS: Record<string, ModuleParamsSchema> = {
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
  minQuality: schema({ minQuality: { type: 'number' } }),
  noLowEffort: schema({ minMeaningfulTextLength: { type: 'number' }, maxEmojiRatio: { type: 'number' } }),
  linkCount: schema({ minLinks: { type: 'number' }, maxLinks: { type: 'number' } }),
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

/** A raw UI param descriptor (labelKey is derived per-module in {@link toEntry}). */
interface RawParam {
  key: string;
  control: ModuleParamControl;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  maxItems?: number;
  default?: boolean | number | string | readonly string[];
}

/** A module's UI metadata: category + English default label/description + params. */
interface ModuleMeta {
  category: ModuleCategory;
  label: string;
  description: string;
  params?: RawParam[];
}

/** number-range builder. */
function num(key: string, label: string, min: number, max: number, step: number, def?: number): RawParam {
  return { key, control: 'number-range', label, min, max, step, ...(def !== undefined ? { default: def } : {}) };
}

/** free-entry multiselect (tag input) builder. */
function tags(key: string, label: string, maxItems: number): RawParam {
  return { key, control: 'multiselect', label, maxItems };
}

/** fixed-option multiselect builder. */
function pick(key: string, label: string, options: Array<{ value: string; label: string }>, maxItems: number): RawParam {
  return { key, control: 'multiselect', label, options, maxItems };
}

// ── Duration helpers (recencyWindow is stored in ms; the UI tunes whole hours) ──
const HOUR_MS = 60 * 60 * 1000;

/**
 * Curated per-module UI metadata. The SINGLE place a module's category, default
 * strings, and renderable param controls live. Any userComposable module missing
 * a row falls back to a kind-derived category + humanized label + no params.
 */
const MODULE_METADATA: Record<string, ModuleMeta> = {
  // ── Sources ──────────────────────────────────────────────────────────────
  keywords: {
    category: 'source', label: 'Keywords & hashtags',
    description: 'Posts matching any of these keywords or hashtags.',
    params: [tags('keywords', 'Keywords', 50), tags('hashtags', 'Hashtags', 50)],
  },
  accounts: {
    category: 'source', label: 'Accounts',
    description: 'Posts from a chosen set of accounts.',
    params: [tags('authorIds', 'Accounts', 200)],
  },
  topic: { category: 'source', label: 'Topic', description: 'Posts classified under a topic.' },
  starterPack: { category: 'source', label: 'Starter pack', description: 'Posts from a starter pack’s members.' },
  quotes: {
    category: 'source', label: 'Quotes',
    description: 'Quote posts of a post or from chosen accounts.',
    params: [tags('authorIds', 'Accounts', 200)],
  },
  instance: { category: 'source', label: 'Instance', description: 'Posts from a federated instance.' },
  links: { category: 'source', label: 'Links', description: 'Posts linking to a domain.' },
  moreLikeThis: {
    category: 'source', label: 'More like this',
    description: 'Posts similar to a seed post (topics, hashtags, author).',
    params: [tags('topics', 'Topics', 20), tags('hashtags', 'Hashtags', 20)],
  },
  nearby: {
    category: 'source', label: 'Nearby',
    description: 'Posts near a location.',
    params: [num('radiusKm', 'Radius (km)', 1, 500, 1, 25)],
  },
  risingCreators: { category: 'source', label: 'Rising creators', description: 'Posts from fast-growing new creators.' },
  trending: { category: 'source', label: 'Trending', description: 'Recent high-engagement posts.' },
  globalDiscovery: { category: 'source', label: 'Global discovery', description: 'Recent public posts, for serendipity.' },
  questions: { category: 'source', label: 'Questions', description: 'Posts that ask a question.' },
  news: { category: 'source', label: 'News', description: 'Posts sharing news links.' },
  newVoices: { category: 'source', label: 'New voices', description: 'Posts from accounts new to the network.' },
  topReplies: { category: 'source', label: 'Top replies', description: 'The most-engaged replies.' },
  curated: { category: 'source', label: 'Curated', description: 'An editorially curated set of posts.' },

  // ── Filters: quality / low-effort ─────────────────────────────────────────
  minQuality: {
    category: 'quality', label: 'Minimum quality',
    description: 'Keep only posts whose classified quality is at or above the threshold. Posts without a trusted score pass through.',
    params: [num('minQuality', 'Quality floor', 0, 1, 0.05, 0.3)],
  },
  noLowEffort: {
    category: 'quality', label: 'No low-effort',
    description: 'Drop emoji-only, shortcode-only, and text-empty posts (unless they carry media). Optionally drop emoji-heavy posts.',
    params: [
      num('minMeaningfulTextLength', 'Minimum real text', 0, 200, 1, 12),
      num('maxEmojiRatio', 'Max emoji ratio', 0, 1, 0.05, 0.5),
    ],
  },
  noBots: {
    category: 'quality', label: 'No bots',
    description: 'Drop RSS/bridge mirrors and link-only news bots.',
  },
  minEngagement: {
    category: 'engagement', label: 'Minimum engagement',
    description: 'Keep only posts meeting each engagement threshold.',
    params: [
      num('minLikes', 'Min likes', 0, 100000, 1),
      num('minBoosts', 'Min boosts', 0, 100000, 1),
      num('minComments', 'Min comments', 0, 100000, 1),
      num('minViews', 'Min views', 0, 1000000, 1),
      num('minShares', 'Min shares', 0, 100000, 1),
    ],
  },
  minLength: {
    category: 'quality', label: 'Minimum length',
    description: 'Drop posts shorter than this many characters.',
    params: [num('minLength', 'Min characters', 0, 500, 1)],
  },
  maxLength: {
    category: 'quality', label: 'Maximum length',
    description: 'Drop posts longer than this many characters.',
    params: [num('maxLength', 'Max characters', 0, 5000, 1)],
  },
  recencyWindow: {
    category: 'recency', label: 'Recency window',
    description: 'Keep only posts newer than this window.',
    params: [num('windowMs', 'Window (hours)', HOUR_MS, 30 * 24 * HOUR_MS, HOUR_MS, 24 * HOUR_MS)],
  },

  // ── Filters: media / content type ─────────────────────────────────────────
  mediaOnly: { category: 'media', label: 'Media only', description: 'Keep only posts with media.' },
  videoOnly: { category: 'media', label: 'Videos only', description: 'Keep only posts with a video.' },
  hasImage: { category: 'media', label: 'Has image', description: 'Keep only posts with an image.' },
  hasGif: { category: 'media', label: 'Has GIF', description: 'Keep only posts with a GIF.' },
  hasPoll: { category: 'media', label: 'Has poll', description: 'Keep only posts with a poll.' },
  hasAltText: { category: 'media', label: 'Has alt text', description: 'Keep only posts whose media has alt text.' },
  textOnly: { category: 'media', label: 'Text only', description: 'Keep only text posts (no media or poll).' },
  noBoosts: { category: 'media', label: 'No boosts', description: 'Drop boost/repost posts.' },
  noReplies: { category: 'media', label: 'No replies', description: 'Drop replies.' },
  onlyReplies: { category: 'media', label: 'Only replies', description: 'Keep only replies.' },
  excludeQuotes: { category: 'media', label: 'No quotes', description: 'Drop quote posts.' },
  originalOnly: { category: 'media', label: 'Original only', description: 'Keep only original posts (no boosts or quotes).' },

  // ── Filters: links / network ──────────────────────────────────────────────
  linkCount: {
    category: 'network', label: 'Link count',
    description: 'Keep only posts whose number of links is within the range.',
    params: [num('minLinks', 'Min links', 0, 20, 1), num('maxLinks', 'Max links', 0, 20, 1)],
  },
  hasLink: { category: 'network', label: 'Has link', description: 'Keep only posts that contain a link.' },
  localOnly: { category: 'network', label: 'Local only', description: 'Keep only local (non-federated) posts.' },
  federatedOnly: { category: 'network', label: 'Federated only', description: 'Keep only federated posts.' },
  domainAllowlist: {
    category: 'network', label: 'Domain allowlist',
    description: 'Keep only posts linking to an allowed domain.',
    params: [tags('domains', 'Domains', 100)],
  },
  domainDenylist: {
    category: 'network', label: 'Domain denylist',
    description: 'Drop posts linking to a denied domain.',
    params: [tags('domains', 'Domains', 100)],
  },
  instanceAllowlist: {
    category: 'network', label: 'Instance allowlist',
    description: 'Keep only local posts + posts from an allowed instance.',
    params: [tags('instances', 'Instances', 100)],
  },
  instanceDenylist: {
    category: 'network', label: 'Instance denylist',
    description: 'Drop posts from a denied instance.',
    params: [tags('instances', 'Instances', 100)],
  },

  // ── Filters: language ─────────────────────────────────────────────────────
  languagePreference: {
    category: 'language', label: 'Languages',
    description: 'Keep only posts in one of these languages (posts with no declared language pass through).',
    params: [tags('languages', 'Languages', 20)],
  },
  languageStrict: {
    category: 'language', label: 'Declared language required',
    description: 'Drop posts with no declared language.',
  },

  // ── Filters: topics / words ───────────────────────────────────────────────
  topicAllowlist: {
    category: 'topics', label: 'Topic allowlist',
    description: 'Keep only posts whose topics overlap the allowlist.',
    params: [tags('topics', 'Topics', 100)],
  },
  topicDenylist: {
    category: 'topics', label: 'Topic denylist',
    description: 'Drop posts whose topics overlap the denylist.',
    params: [tags('topics', 'Topics', 100)],
  },
  customMuteWords: {
    category: 'topics', label: 'Mute words',
    description: 'Drop posts matching any of these words.',
    params: [tags('words', 'Words', 200)],
  },
  keywordDenylist: {
    category: 'topics', label: 'Keyword denylist',
    description: 'Drop posts matching any of these keywords.',
    params: [tags('keywords', 'Keywords', 50)],
  },
  sentimentFilter: {
    category: 'topics', label: 'Sentiment',
    description: 'Keep only posts with the selected classified sentiment.',
    params: [pick('sentiments', 'Sentiments', [
      { value: 'positive', label: 'Positive' },
      { value: 'neutral', label: 'Neutral' },
      { value: 'negative', label: 'Negative' },
    ], 3)],
  },

  // ── Filters: authors ──────────────────────────────────────────────────────
  muteBlock: {
    category: 'authors', label: 'Muted accounts',
    description: 'Drop posts from these accounts.',
    params: [tags('excludedIds', 'Accounts', 1000)],
  },
  excludeFollowing: {
    category: 'authors', label: 'Exclude following',
    description: 'Drop posts from accounts you already follow (discovery).',
  },
  verifiedOnly: { category: 'authors', label: 'Verified only', description: 'Keep only posts by verified accounts.' },
  verifiedFollowsOnly: {
    category: 'authors', label: 'Verified follows only',
    description: 'Keep only posts by verified accounts you follow.',
  },
  minFollowers: {
    category: 'authors', label: 'Minimum followers',
    description: 'Keep only posts by accounts with at least this many followers.',
    params: [num('minFollowers', 'Min followers', 0, 10000000, 1)],
  },
  minAccountAge: {
    category: 'authors', label: 'Minimum account age',
    description: 'Keep only posts by accounts older than this many days.',
    params: [num('minAgeDays', 'Min age (days)', 0, 3650, 1)],
  },

  // ── Filters: safety ───────────────────────────────────────────────────────
  onlySensitive: { category: 'safety', label: 'Sensitive only', description: 'Keep only sensitive posts.' },
  excludeSensitive: { category: 'safety', label: 'Exclude sensitive', description: 'Drop sensitive posts.' },
};

/** Signals surfaced in the builder — all share the `ranking` category. */
const SIGNAL_LABELS: Record<string, { label: string; description: string }> = {
  engagement: { label: 'Engagement', description: 'Rank by likes, boosts, comments, and views.' },
  recency: { label: 'Recency', description: 'Favor newer posts.' },
  authorRelationship: { label: 'Relationship', description: 'Favor posts from accounts you interact with.' },
  authorAuthority: { label: 'Authority', description: 'A modest lift for established accounts.' },
  personalization: { label: 'Personalization', description: 'Favor posts matching your topics, type, and language.' },
  quality: { label: 'Quality', description: 'Favor higher-quality posts, downrank spam.' },
  trendingVelocity: { label: 'Trending', description: 'Favor posts gaining engagement quickly.' },
  timeOfDay: { label: 'Time of day', description: 'A light time-of-day relevance adjustment.' },
  diversity: { label: 'Diversity', description: 'Mix authors and topics across the page.' },
  mediaBoost: { label: 'Media boost', description: 'Favor posts with media.' },
  positivity: { label: 'Positivity', description: 'Favor positive-sentiment posts.' },
  conversational: { label: 'Conversational', description: 'Favor constructive, conversational posts.' },
  coldStartBoost: { label: 'Cold-start boost', description: 'Surface fresh posts and new authors.' },
  penalizeSeen: { label: 'Penalize seen', description: 'Downrank posts you have already seen.' },
  verifiedBoost: { label: 'Verified boost', description: 'A small lift for verified authors.' },
  dwellTime: { label: 'Dwell time', description: 'Favor posts people spend longer reading.' },
  socialProof: { label: 'Social proof', description: 'Lift posts your network engaged with.' },
  reciprocityBoost: { label: 'Reciprocity', description: 'Favor accounts you mutually engage with.' },
  noveltyBoost: { label: 'Novelty', description: 'Explore topics you have not seen recently.' },
  localBoost: { label: 'Local boost', description: 'A modest lift for local (non-federated) posts.' },
  languageMismatchPenalty: { label: 'Off-language penalty', description: 'Downrank discovery posts not in your languages.' },
};

/** Whether a registry module should be offered to the custom-feed builder. */
function isComposable(kind: ModuleKind, userComposable: boolean | undefined): boolean {
  if (kind === 'signal') return true; // every ranking signal is selectable in ranked mode
  return userComposable === true;
}

/** Coarse default category when a module has no curated {@link MODULE_METADATA} row. */
function defaultCategory(kind: ModuleKind): ModuleCategory {
  if (kind === 'source') return 'source';
  if (kind === 'signal') return 'ranking';
  return 'topics';
}

/** Humanize a camelCase module id into a fallback label (e.g. `hasAltText` → `Has alt text`). */
function humanize(id: string): string {
  const spaced = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Fill a {@link RawParam} into a full {@link ModuleParamDescriptor} (deriving i18n keys). */
function toParamDescriptor(moduleId: string, raw: RawParam): ModuleParamDescriptor {
  const descriptor: ModuleParamDescriptor = {
    key: raw.key,
    control: raw.control,
    labelKey: `feeds.modules.${moduleId}.params.${raw.key}`,
    label: raw.label,
  };
  if (raw.min !== undefined) descriptor.min = raw.min;
  if (raw.max !== undefined) descriptor.max = raw.max;
  if (raw.step !== undefined) descriptor.step = raw.step;
  if (raw.maxItems !== undefined) descriptor.maxItems = raw.maxItems;
  if (raw.default !== undefined) descriptor.default = raw.default;
  if (raw.options) {
    descriptor.options = raw.options.map((o) => ({
      value: o.value,
      labelKey: `feeds.modules.${moduleId}.options.${o.value}`,
      label: o.label,
    }));
  }
  return descriptor;
}

function toEntry(id: string, kind: ModuleKind): ModuleCatalogEntry {
  const meta = MODULE_METADATA[id];
  const signal = kind === 'signal' ? SIGNAL_LABELS[id] : undefined;
  const category: ModuleCategory = meta?.category ?? defaultCategory(kind);
  const label = meta?.label ?? signal?.label ?? humanize(id);
  const description = meta?.description ?? signal?.description ?? '';
  const params = (meta?.params ?? []).map((raw) => toParamDescriptor(id, raw));

  return {
    id,
    kind,
    category,
    labelKey: `feeds.modules.${id}.label`,
    descriptionKey: `feeds.modules.${id}.description`,
    label,
    description,
    params,
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
