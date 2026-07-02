/**
 * Filter modules — thin wrappers over the existing feed-safety / tuner helpers.
 * Each may contribute a Mongo `clause()` (pushed into source queries) and/or an
 * in-memory `keep()` predicate (applied to the merged candidate pool). No new
 * filtering logic — every rule mirrors a pre-existing feed behavior.
 */

import { PostType } from '@mention/shared-types';
import { isSensitivePost, DISCOVERY_SAFE_MATCH, FeedSafetyPostShape } from '../../feedSafety';
import { feedModuleRegistry, FeedModuleRegistry } from '../FeedModuleRegistry';
import type { CandidatePost, FilterModule } from '../types';

/** Read a nested field off a lean candidate without widening to `any`. */
function field<T = unknown>(post: CandidatePost, key: string): T | undefined {
  return (post as Record<string, unknown>)[key] as T | undefined;
}

/** Whether the candidate carries any media attachment (mirrors the Media feed predicate). */
function hasMedia(post: CandidatePost): boolean {
  const type = field<string>(post, 'type');
  if (type === PostType.IMAGE || type === PostType.VIDEO) return true;
  const content = field<{ media?: unknown[]; attachments?: Array<{ type?: string }> }>(post, 'content');
  if (Array.isArray(content?.media) && content.media.length > 0) return true;
  if (Array.isArray(content?.attachments) && content.attachments.some((a) => a?.type === 'media')) return true;
  return false;
}

/** Whether the candidate carries a video (mirrors the Videos feed predicate). */
function hasVideo(post: CandidatePost): boolean {
  const type = field<string>(post, 'type');
  if (type === PostType.VIDEO) return true;
  const content = field<{ media?: Array<{ type?: string }> }>(post, 'content');
  return Array.isArray(content?.media) && content.media.some((m) => m?.type === 'video');
}

/**
 * `safety`: the single sensitive/NSFW gate (wraps {@link feedSafety}). Drops
 * sensitive posts for safe-for-work viewers; a Mongo clause is available for
 * query pushdown on discovery feeds.
 */
export const safetyFilter: FilterModule = {
  id: 'safety',
  kind: 'filter',
  clause: (ctx) => (ctx.showSensitiveContent === true ? undefined : { ...DISCOVERY_SAFE_MATCH }),
  keep: (post, ctx) =>
    ctx.showSensitiveContent === true ? true : !isSensitivePost(post as unknown as FeedSafetyPostShape),
};

/**
 * `languagePreference`: any-overlap language match against
 * `postClassification.languages` (wraps the array-based `filterByLanguage`).
 * Posts with no declared language pass through.
 */
export const languagePreferenceFilter: FilterModule = {
  id: 'languagePreference',
  kind: 'filter',
  keep: (post, _ctx, params) => {
    const prefs = Array.isArray(params.languages) ? (params.languages as string[]) : [];
    if (prefs.length === 0) return true;
    const prefSet = new Set(prefs.map((l) => l.toLowerCase()));
    const classification = field<{ languages?: string[] }>(post, 'postClassification');
    const langs = classification?.languages;
    if (!Array.isArray(langs) || langs.length === 0) return true;
    return langs.some((l) => prefSet.has(l.toLowerCase()));
  },
};

/** `muteBlock`: drops posts authored by ids in `params.excludedIds`. */
export const muteBlockFilter: FilterModule = {
  id: 'muteBlock',
  kind: 'filter',
  keep: (post, _ctx, params) => {
    const excluded = Array.isArray(params.excludedIds) ? (params.excludedIds as string[]) : [];
    if (excluded.length === 0) return true;
    const authorId = post.oxyUserId;
    return !authorId || !excluded.includes(authorId);
  },
};

/** `noBoosts`: excludes boost posts (mirror shape surfaced via the original). */
export const noBoostsFilter: FilterModule = {
  id: 'noBoosts',
  kind: 'filter',
  clause: () => ({ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }),
  keep: (post) => {
    const boostOf = field(post, 'boostOf');
    return boostOf === undefined || boostOf === null;
  },
};

/** `noReplies`: excludes replies (posts with a parent). */
export const noRepliesFilter: FilterModule = {
  id: 'noReplies',
  kind: 'filter',
  clause: () => ({ $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] }),
  keep: (post) => {
    const parent = field(post, 'parentPostId');
    return parent === undefined || parent === null;
  },
};

/** `mediaOnly`: keeps only posts carrying media. */
export const mediaOnlyFilter: FilterModule = {
  id: 'mediaOnly',
  kind: 'filter',
  keep: (post) => hasMedia(post),
};

/** `videoOnly`: keeps only posts carrying a video. */
export const videoOnlyFilter: FilterModule = {
  id: 'videoOnly',
  kind: 'filter',
  keep: (post) => hasVideo(post),
};

/**
 * `dedupe`: marker filter. De-duplication by `_id` is performed natively by the
 * engine merge; this exists so a definition can declare the intent explicitly.
 */
export const dedupeFilter: FilterModule = {
  id: 'dedupe',
  kind: 'filter',
};

/** `recencyWindow`: keeps posts within `params.windowMs` of now. */
export const recencyWindowFilter: FilterModule = {
  id: 'recencyWindow',
  kind: 'filter',
  clause: (_ctx, params) => {
    const windowMs = typeof params.windowMs === 'number' ? params.windowMs : undefined;
    if (windowMs === undefined) return undefined;
    return { createdAt: { $gte: new Date(Date.now() - windowMs) } };
  },
  keep: (post, _ctx, params) => {
    const windowMs = typeof params.windowMs === 'number' ? params.windowMs : undefined;
    if (windowMs === undefined) return true;
    const created = new Date((post.createdAt as Date | string | undefined) ?? 0).getTime();
    return Number.isFinite(created) && created >= Date.now() - windowMs;
  },
};

export const filterModules: FilterModule[] = [
  safetyFilter,
  languagePreferenceFilter,
  muteBlockFilter,
  noBoostsFilter,
  noRepliesFilter,
  mediaOnlyFilter,
  videoOnlyFilter,
  dedupeFilter,
  recencyWindowFilter,
];

export function registerFilterModules(registry: FeedModuleRegistry = feedModuleRegistry): void {
  for (const module of filterModules) registry.register(module);
}
