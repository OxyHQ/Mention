/**
 * Filter modules — thin wrappers over the existing feed-safety / tuner helpers.
 * Each may contribute a Mongo `clause()` (pushed into source queries) and/or an
 * in-memory `keep()` predicate (applied to the merged candidate pool). No new
 * filtering logic — every rule mirrors a pre-existing feed behavior.
 */

import { PostType, MtnConfig } from '@mention/shared-types';
import type { ForYouFeedTuning, PostContent } from '@mention/shared-types';
import { isSensitivePost, DISCOVERY_SAFE_MATCH } from '../../feedSafety';
import { detectLowEffort } from '../../../../services/contentClassification/lowEffort';
import { detectBotShape } from '../../../../services/contentClassification/botSignals';
import { readTrustedScores } from '../../../../services/contentClassification/trustedScores';
import { SPAM_QUALITY_CONFIG, visibleText } from '../../../../services/contentClassification/spamQuality';
import { resolveVariant } from '../../../../services/postVariants';
import { feedModuleRegistry, FeedModuleRegistry } from '../FeedModuleRegistry';
import type { CandidatePost, FeedEngineContext, FilterModule } from '../types';

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

/** Whether the candidate carries a media item of a specific type. */
function hasMediaType(post: CandidatePost, mediaType: 'image' | 'gif'): boolean {
  if (mediaType === 'image' && field<string>(post, 'type') === PostType.IMAGE) return true;
  const content = field<{ media?: Array<{ type?: string }> }>(post, 'content');
  return Array.isArray(content?.media) && content.media.some((m) => m?.type === mediaType);
}

/** Whether the candidate carries a poll. */
function hasPoll(post: CandidatePost): boolean {
  if (field<string>(post, 'type') === PostType.POLL) return true;
  const content = field<{ poll?: unknown; pollId?: unknown; attachments?: Array<{ type?: string }> }>(post, 'content');
  if (content?.poll || content?.pollId) return true;
  if (field(post, 'pollId')) return true;
  return Array.isArray(content?.attachments) && content.attachments.some((a) => a?.type === 'poll');
}

/** Whether the candidate carries any alt-text on a media item (accessibility). */
function hasAltText(post: CandidatePost): boolean {
  const content = field<{ media?: Array<{ alt?: string }> }>(post, 'content');
  return Array.isArray(content?.media) && content.media.some((m) => typeof m?.alt === 'string' && m.alt.trim().length > 0);
}

/** HTTP(S) URL token — global so `.match()` collects every hit. */
const TEXT_URL_PATTERN = /https?:\/\/[^\s]+/gi;

/** All URLs cited in `content.sources` or inlined in the post's primary body. */
function contentUrls(post: CandidatePost): string[] {
  const content = field<PostContent>(post, 'content');
  const urls: string[] = [];
  if (Array.isArray(content?.sources)) {
    for (const source of content.sources) if (typeof source?.url === 'string' && source.url) urls.push(source.url);
  }
  const matches = contentText(post).match(TEXT_URL_PATTERN);
  if (matches) urls.push(...matches);
  return urls;
}

/** Count of HTTP(S) URLs inlined in a text body (the bot-shape link signal). */
function countTextUrls(text: string): number {
  return (text.match(TEXT_URL_PATTERN) ?? []).length;
}

/** The lowercase host of a URL, or `undefined` when it is not parseable. */
function urlHost(url: string): string | undefined {
  const match = /^https?:\/\/([^/:?#\s]+)/i.exec(url);
  return match ? match[1].toLowerCase() : undefined;
}

/** Lowercase link hosts referenced by the candidate. */
function linkHosts(post: CandidatePost): string[] {
  const hosts: string[] = [];
  for (const url of contentUrls(post)) {
    const host = urlHost(url);
    if (host) hosts.push(host);
  }
  return hosts;
}

/** Whether a host equals or is a subdomain of a listed domain. */
function hostMatchesAny(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The candidate's federated instance host (lowercase), or `undefined` when local. */
function federationHost(post: CandidatePost): string | undefined {
  const federation = field<{ actorUri?: string }>(post, 'federation');
  return federation?.actorUri ? urlHost(federation.actorUri) : undefined;
}

/** Whether the candidate is a federated post (carries a federation subdoc). */
function isFederated(post: CandidatePost): boolean {
  const federation = field(post, 'federation');
  return federation !== undefined && federation !== null;
}

/**
 * The candidate's PRIMARY body, or `''` when it has none. The body lives in
 * `content.variants`; the primary rendition is what the author actually wrote,
 * and it is what every text SIGNAL (length, link count, low-effort/bot shape) is
 * computed from — scoring a machine translation would score our own output.
 */
function contentText(post: CandidatePost): string {
  const content = field<PostContent>(post, 'content');
  return content ? resolveVariant(content).text : '';
}

/**
 * EVERY rendition's body — author-written and machine-translated alike.
 *
 * This is what a SAFETY filter reads. A muted word has to hide the post whichever
 * language the reader is served it in; matching only the primary would let the
 * exact rendition a reader sees slip through the filter that exists to hide it.
 */
function allVariantTexts(post: CandidatePost): string[] {
  const content = field<PostContent>(post, 'content');
  const variants = content?.variants;
  if (!Array.isArray(variants) || variants.length === 0) return [];
  return variants
    .map((variant) => variant?.text)
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
}

/** Length of the candidate's text body. */
function textLength(post: CandidatePost): number {
  return contentText(post).length;
}

/** A numeric engagement stat off the candidate, defaulting to 0. */
function statCount(post: CandidatePost, key: string): number {
  const stats = field<Record<string, unknown>>(post, 'stats');
  const value = stats?.[key];
  return typeof value === 'number' ? value : 0;
}

/** The candidate's classified topics (lowercased), or `[]`. */
function classificationTopics(post: CandidatePost): string[] {
  const classification = field<{ topics?: string[] }>(post, 'postClassification');
  return Array.isArray(classification?.topics) ? classification.topics.map((t) => t.toLowerCase()) : [];
}

/** Whether the candidate text or hashtags contain any of the given words (case-insensitive, word-boundary for text). */
function matchesAnyWord(post: CandidatePost, words: string[]): boolean {
  if (words.length === 0) return false;
  const texts = allVariantTexts(post);
  const hashtags = (field<string[]>(post, 'hashtags') ?? []).map((h) => h.toLowerCase());
  for (const word of words) {
    const lower = word.toLowerCase();
    if (hashtags.includes(lower.replace(/^#/, ''))) return true;
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i');
    if (texts.some((text) => pattern.test(text))) return true;
  }
  return false;
}

/**
 * Author verification flag, when the candidate carries a resolved author. Absent
 * on lean candidates (author identity is Oxy user data hydrated later) → returns
 * `undefined`. See the Phase-4 note on {@link verifiedOnlyFilter}.
 */
function authorVerified(post: CandidatePost): boolean | undefined {
  const user = field<{ verified?: boolean }>(post, 'user');
  const author = field<{ verified?: boolean }>(post, 'author');
  return user?.verified ?? author?.verified;
}

/** Author follower count, when resolved on the candidate. Absent on lean candidates. */
function authorFollowerCount(post: CandidatePost): number | undefined {
  const user = field<{ _count?: { followers?: number }; followersCount?: number }>(post, 'user');
  const author = field<{ followerCount?: number; followersCount?: number }>(post, 'author');
  return user?._count?.followers ?? user?.followersCount ?? author?.followerCount ?? author?.followersCount;
}

/**
 * `safety`: the single sensitive/NSFW gate (wraps {@link feedSafety}). Always
 * drops sensitive posts — no viewer opt-in bypass. A Mongo clause is available
 * for query pushdown on discovery feeds.
 */
export const safetyFilter: FilterModule = {
  id: 'safety',
  kind: 'filter',
  clause: () => ({ ...DISCOVERY_SAFE_MATCH }),
  keep: (post) => !isSensitivePost(post),
};

/**
 * `languagePreference`: any-overlap language match against
 * `postClassification.languages` (wraps the array-based `filterByLanguage`).
 * Posts with no declared language pass through. User-composable: it is a
 * first-class custom-feed filter and the target of the legacy `language`
 * migration, so it must be selectable in the builder.
 */
export const languagePreferenceFilter: FilterModule = {
  id: 'languagePreference',
  kind: 'filter',
  userComposable: true,
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

/**
 * `muteBlock`: drops posts authored by ids in `params.excludedIds`. User-composable
 * (per-feed account muting in the builder + the target of the legacy owner-exclusion
 * migration). It only ever EXCLUDES authors, so it carries no IDOR surface.
 */
export const muteBlockFilter: FilterModule = {
  id: 'muteBlock',
  kind: 'filter',
  userComposable: true,
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
  userComposable: true,
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
  userComposable: true,
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
  userComposable: true,
  keep: (post) => hasMedia(post),
};

/** `videoOnly`: keeps only posts carrying a video. */
export const videoOnlyFilter: FilterModule = {
  id: 'videoOnly',
  kind: 'filter',
  userComposable: true,
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
  userComposable: true,
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

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 filter catalog. All are user-composable (surfaced in the builder) and
// applied as in-memory `keep()` predicates on the merged candidate pool.
// ─────────────────────────────────────────────────────────────────────────

/** `excludeFollowing`: drop posts authored by anyone the viewer follows (discovery). */
export const excludeFollowingFilter: FilterModule = {
  id: 'excludeFollowing',
  kind: 'filter',
  userComposable: true,
  keep: (post, ctx) => {
    const following = ctx.followingIds ?? [];
    return !post.oxyUserId || !following.includes(post.oxyUserId);
  },
};

/** `hasImage`: keep only posts carrying an image. */
export const hasImageFilter: FilterModule = {
  id: 'hasImage',
  kind: 'filter',
  userComposable: true,
  keep: (post) => hasMediaType(post, 'image'),
};

/** `hasGif`: keep only posts carrying a GIF. */
export const hasGifFilter: FilterModule = {
  id: 'hasGif',
  kind: 'filter',
  userComposable: true,
  keep: (post) => hasMediaType(post, 'gif'),
};

/** `hasPoll`: keep only posts carrying a poll. */
export const hasPollFilter: FilterModule = {
  id: 'hasPoll',
  kind: 'filter',
  userComposable: true,
  keep: (post) => hasPoll(post),
};

/** `hasLink`: keep only posts that contain a link. */
export const hasLinkFilter: FilterModule = {
  id: 'hasLink',
  kind: 'filter',
  userComposable: true,
  keep: (post) => linkHosts(post).length > 0,
};

/** `hasAltText`: keep only posts whose media carries alt-text (accessibility). */
export const hasAltTextFilter: FilterModule = {
  id: 'hasAltText',
  kind: 'filter',
  userComposable: true,
  keep: (post) => hasAltText(post),
};

/** `textOnly`: keep only text posts (no media, no poll). */
export const textOnlyFilter: FilterModule = {
  id: 'textOnly',
  kind: 'filter',
  userComposable: true,
  keep: (post) => !hasMedia(post) && !hasPoll(post),
};

/** `excludeQuotes`: drop quote posts. */
export const excludeQuotesFilter: FilterModule = {
  id: 'excludeQuotes',
  kind: 'filter',
  userComposable: true,
  clause: () => ({ $or: [{ quoteOf: null }, { quoteOf: { $exists: false } }] }),
  keep: (post) => {
    const quoteOf = field(post, 'quoteOf');
    return quoteOf === undefined || quoteOf === null;
  },
};

/** `originalOnly`: drop boosts AND quotes (only wholly-original posts). */
export const originalOnlyFilter: FilterModule = {
  id: 'originalOnly',
  kind: 'filter',
  userComposable: true,
  keep: (post) => {
    const boostOf = field(post, 'boostOf');
    const quoteOf = field(post, 'quoteOf');
    const type = field<string>(post, 'type');
    return (boostOf === undefined || boostOf === null)
      && (quoteOf === undefined || quoteOf === null)
      && type !== PostType.BOOST
      && type !== PostType.QUOTE;
  },
};

/** `onlyReplies`: keep only replies (posts with a parent). */
export const onlyRepliesFilter: FilterModule = {
  id: 'onlyReplies',
  kind: 'filter',
  userComposable: true,
  clause: () => ({ parentPostId: { $ne: null } }),
  keep: (post) => {
    const parent = field(post, 'parentPostId');
    return parent !== undefined && parent !== null;
  },
};

/** `minEngagement`: keep posts meeting every provided engagement threshold. */
export const minEngagementFilter: FilterModule = {
  id: 'minEngagement',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const thresholds: Array<[string, string]> = [
      ['minLikes', 'likesCount'],
      ['minBoosts', 'boostsCount'],
      ['minComments', 'commentsCount'],
      ['minViews', 'viewsCount'],
      ['minShares', 'sharesCount'],
    ];
    for (const [paramKey, statKey] of thresholds) {
      const threshold = params[paramKey];
      if (typeof threshold === 'number' && statCount(post, statKey) < threshold) return false;
    }
    return true;
  },
};

/** `maxLength`: drop posts whose text exceeds `params.maxLength` characters. */
export const maxLengthFilter: FilterModule = {
  id: 'maxLength',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const max = typeof params.maxLength === 'number' ? params.maxLength : undefined;
    return max === undefined ? true : textLength(post) <= max;
  },
};

/**
 * `minLength`: drop posts whose text is shorter than `params.minLength`
 * characters. As a For You gate module (`params.forYouGate`) the viewer may
 * disable the floor or override the threshold via `feedTuning.forYou.minLength`.
 */
export const minLengthFilter: FilterModule = {
  id: 'minLength',
  kind: 'filter',
  userComposable: true,
  keep: (post, ctx, params) => {
    const tuning = gateTuning(ctx, params, 'minLength');
    if (tuning?.enabled === false) return true;
    const min = typeof tuning?.minLength === 'number'
      ? tuning.minLength
      : (typeof params.minLength === 'number' ? params.minLength : undefined);
    return min === undefined ? true : textLength(post) >= min;
  },
};

/** `domainAllowlist`: keep only posts linking to an allowed domain. */
export const domainAllowlistFilter: FilterModule = {
  id: 'domainAllowlist',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const domains = (Array.isArray(params.domains) ? (params.domains as string[]) : []).map((d) => d.toLowerCase());
    if (domains.length === 0) return true;
    const hosts = linkHosts(post);
    return hosts.length > 0 && hosts.some((h) => hostMatchesAny(h, domains));
  },
};

/** `domainDenylist`: drop posts linking to a denied domain. */
export const domainDenylistFilter: FilterModule = {
  id: 'domainDenylist',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const domains = (Array.isArray(params.domains) ? (params.domains as string[]) : []).map((d) => d.toLowerCase());
    if (domains.length === 0) return true;
    return !linkHosts(post).some((h) => hostMatchesAny(h, domains));
  },
};

/** `customMuteWords`: drop posts matching any of `params.words` (viewer/per-feed mute). */
export const customMuteWordsFilter: FilterModule = {
  id: 'customMuteWords',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const words = Array.isArray(params.words) ? (params.words as string[]) : [];
    return !matchesAnyWord(post, words);
  },
};

/** `keywordDenylist`: drop posts matching any of `params.keywords` (per-feed exclusion). */
export const keywordDenylistFilter: FilterModule = {
  id: 'keywordDenylist',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const keywords = Array.isArray(params.keywords) ? (params.keywords as string[]) : [];
    return !matchesAnyWord(post, keywords);
  },
};

/** `languageStrict`: drop posts with no declared classification language. */
export const languageStrictFilter: FilterModule = {
  id: 'languageStrict',
  kind: 'filter',
  userComposable: true,
  keep: (post) => {
    const classification = field<{ languages?: string[] }>(post, 'postClassification');
    return Array.isArray(classification?.languages) && classification.languages.length > 0;
  },
};

/** `localOnly`: keep only local (non-federated) posts. */
export const localOnlyFilter: FilterModule = {
  id: 'localOnly',
  kind: 'filter',
  userComposable: true,
  clause: () => ({ $or: [{ federation: null }, { federation: { $exists: false } }] }),
  keep: (post) => !isFederated(post),
};

/** `federatedOnly`: keep only federated posts. */
export const federatedOnlyFilter: FilterModule = {
  id: 'federatedOnly',
  kind: 'filter',
  userComposable: true,
  clause: () => ({ federation: { $exists: true, $ne: null } }),
  keep: (post) => isFederated(post),
};

/** `instanceAllowlist`: keep local posts + posts from an allowed instance host. */
export const instanceAllowlistFilter: FilterModule = {
  id: 'instanceAllowlist',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const instances = (Array.isArray(params.instances) ? (params.instances as string[]) : []).map((i) => i.toLowerCase());
    if (instances.length === 0) return true;
    const host = federationHost(post);
    if (!host) return true; // local posts pass an instance allowlist
    return hostMatchesAny(host, instances);
  },
};

/** `instanceDenylist`: drop posts from a denied instance host. */
export const instanceDenylistFilter: FilterModule = {
  id: 'instanceDenylist',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const instances = (Array.isArray(params.instances) ? (params.instances as string[]) : []).map((i) => i.toLowerCase());
    if (instances.length === 0) return true;
    const host = federationHost(post);
    return !host || !hostMatchesAny(host, instances);
  },
};

/** `topicAllowlist`: keep only posts whose classified topics overlap the allowlist. */
export const topicAllowlistFilter: FilterModule = {
  id: 'topicAllowlist',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const topics = (Array.isArray(params.topics) ? (params.topics as string[]) : []).map((t) => t.toLowerCase());
    if (topics.length === 0) return true;
    const postTopics = classificationTopics(post);
    return postTopics.some((t) => topics.includes(t));
  },
};

/** `topicDenylist`: drop posts whose classified topics overlap the denylist. */
export const topicDenylistFilter: FilterModule = {
  id: 'topicDenylist',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const topics = (Array.isArray(params.topics) ? (params.topics as string[]) : []).map((t) => t.toLowerCase());
    if (topics.length === 0) return true;
    return !classificationTopics(post).some((t) => topics.includes(t));
  },
};

/** `sentimentFilter`: keep only posts whose classified sentiment is in `params.sentiments`. */
export const sentimentFilter: FilterModule = {
  id: 'sentimentFilter',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const wanted = (Array.isArray(params.sentiments) ? (params.sentiments as string[]) : []).map((s) => s.toLowerCase());
    if (wanted.length === 0) return true;
    const classification = field<{ sentiment?: string }>(post, 'postClassification');
    const sentiment = classification?.sentiment;
    // No classified sentiment on the lean candidate → cannot match a specific
    // request, so exclude (sentiment is a positive selection).
    return typeof sentiment === 'string' && wanted.includes(sentiment.toLowerCase());
  },
};

/** `onlySensitive`: keep only sensitive posts (e.g. an explicit NSFW feed). */
export const onlySensitiveFilter: FilterModule = {
  id: 'onlySensitive',
  kind: 'filter',
  userComposable: true,
  keep: (post) => isSensitivePost(post),
};

/** `excludeSensitive`: drop sensitive posts regardless of the viewer opt-in. */
export const excludeSensitiveFilter: FilterModule = {
  id: 'excludeSensitive',
  kind: 'filter',
  userComposable: true,
  keep: (post) => !isSensitivePost(post),
};

/**
 * `verifiedOnly`: keep only posts by verified authors.
 *
 * PHASE-4-BLOCKED: author verification is Oxy user data resolved during
 * hydration, NOT on the lean candidate; the engine applies `keep()` PRE-hydration
 * only. So when no author is resolved on the candidate this cannot filter and
 * passes through (it enforces once a resolved author carries `verified`, e.g. a
 * future post-hydration filter hook). It is NOT a silent no-op — the intent is
 * declared and the predicate is correct for any candidate that does carry an
 * author.
 */
export const verifiedOnlyFilter: FilterModule = {
  id: 'verifiedOnly',
  kind: 'filter',
  userComposable: true,
  keep: (post) => {
    const verified = authorVerified(post);
    return verified === undefined ? true : verified === true;
  },
};

/**
 * `verifiedFollowsOnly`: keep only posts by verified accounts the viewer follows.
 * The follow check is exact (viewer follow graph is available); the verification
 * check is PHASE-4-BLOCKED like {@link verifiedOnlyFilter} and applies only when
 * a resolved author carries `verified`.
 */
export const verifiedFollowsOnlyFilter: FilterModule = {
  id: 'verifiedFollowsOnly',
  kind: 'filter',
  userComposable: true,
  keep: (post, ctx) => {
    const following = ctx.followingIds ?? [];
    if (!post.oxyUserId || !following.includes(post.oxyUserId)) return false;
    const verified = authorVerified(post);
    return verified === undefined ? true : verified === true;
  },
};

/**
 * `minFollowers`: keep only posts by authors with at least `params.minFollowers`
 * followers. PHASE-4-BLOCKED: follower count is Oxy user data not on the lean
 * candidate; passes through when absent (enforces on a resolved author).
 */
export const minFollowersFilter: FilterModule = {
  id: 'minFollowers',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const min = typeof params.minFollowers === 'number' ? params.minFollowers : undefined;
    if (min === undefined) return true;
    const followers = authorFollowerCount(post);
    return followers === undefined ? true : followers >= min;
  },
};

/**
 * `minAccountAge`: keep only posts by accounts older than `params.minAgeDays`.
 * PHASE-4-BLOCKED: author account creation date is Oxy user data not on the lean
 * candidate; passes through when absent (enforces on a resolved author).
 */
export const minAccountAgeFilter: FilterModule = {
  id: 'minAccountAge',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const minAgeDays = typeof params.minAgeDays === 'number' ? params.minAgeDays : undefined;
    if (minAgeDays === undefined) return true;
    const author = field<{ createdAt?: string | Date }>(post, 'author') ?? field<{ createdAt?: string | Date }>(post, 'user');
    const createdAt = author?.createdAt;
    if (!createdAt) return true;
    const ageMs = Date.now() - new Date(createdAt).getTime();
    return Number.isFinite(ageMs) && ageMs >= minAgeDays * 24 * 60 * 60 * 1000;
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Phase 4 DISCOVERY GATE — hard filters for OBJECTIVE junk only, applied by the
// engine ONLY to non-trusted (discovery) lanes. Each rule is a REUSABLE PURE
// predicate; the FilterModule is a thin wrapper. Phase 4B re-exposes the same
// predicates as user-composable modules (`noLowEffort`, `noBots`, …); the For You
// default gate reads its thresholds from `MtnConfig.feed.discoveryGate`, with
// per-filter param overrides for custom feeds.
// ─────────────────────────────────────────────────────────────────────────

const DISCOVERY_GATE = MtnConfig.feed.discoveryGate;

/**
 * The per-viewer For You override for a discovery-gate module, or `undefined`
 * when this filter is NOT running as the For You gate. The scoping is the opaque
 * `params.forYouGate` marker that `resolveDiscoveryGate` stamps on the static For
 * You gate refs (and ONLY those) — so the SAME filter reused in a custom feed
 * never picks up a viewer's For You tuning, keeping the definition static while
 * personalization flows through `ctx` (`ctx.feedTuning.forYou`).
 */
function gateTuning<K extends keyof ForYouFeedTuning>(
  ctx: FeedEngineContext,
  params: Record<string, unknown>,
  id: K,
): ForYouFeedTuning[K] | undefined {
  return params.forYouGate === true ? ctx.feedTuning?.forYou?.[id] : undefined;
}

/** Whether the candidate carries any media OR a poll (either rescues a low-text post). */
function hasMediaOrPoll(post: CandidatePost): boolean {
  return hasMedia(post) || hasPoll(post);
}

/** Read a numeric threshold from filter params, falling back to a config default. */
function numParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * `lowEffortGate` predicate (PURE) — reject OBJECTIVE low-effort junk:
 *   1. the post has NO REAL PROSE (emoji-only / custom-emoji-shortcode-only / sub-
 *      threshold real-letter count via {@link detectLowEffort}) AND carries no
 *      media or poll — the "no writing, no picture" case; or
 *   2. the post's TRUSTED classification scores breach the spam / quality floor.
 *
 * The score branch fires ONLY on real provenance ({@link readTrustedScores} !==
 * null); an unscored post (the all-zeros default, or a stale baseline version) is
 * NEVER rejected by scores, so the feed can never empty merely because scores are
 * absent. Pure and pre-hydration safe (reads only lean-projected fields).
 *
 * @returns `true` to KEEP the post, `false` to reject it.
 */
export function passesLowEffortGate(
  post: CandidatePost,
  cfg: { minMeaningfulTextLength: number; spamRejectThreshold: number; qualityRejectThreshold: number },
): boolean {
  const lowEffort = detectLowEffort(contentText(post), { minRealTextLength: cfg.minMeaningfulTextLength });
  const noRealText = lowEffort.isNoRealText || lowEffort.shortcodeOnly || lowEffort.emojiOnly;
  if (noRealText && !hasMediaOrPoll(post)) {
    return false;
  }

  const scores = readTrustedScores(post);
  if (scores) {
    if (scores.spam >= cfg.spamRejectThreshold) return false;
    if (scores.quality <= cfg.qualityRejectThreshold) return false;
  }

  return true;
}

/** Native (non-federated) weighted engagement count: `likes + comments + native boosts`. */
function nativeEngagementCount(post: CandidatePost): number {
  const likes = statCount(post, 'likesCount');
  const comments = statCount(post, 'commentsCount');
  const boosts = statCount(post, 'boostsCount');
  const federatedBoosts = statCount(post, 'federatedBoostsCount');
  return likes + comments + Math.max(0, boosts - federatedBoosts);
}

/**
 * Whether a DISCOVERY candidate matches the viewer's learned interests strongly
 * enough to bypass the native-engagement floor — via ANY of:
 *   - a classified TOPIC overlapping a `preferredTopics` entry above the weight
 *     floor,
 *   - the AUTHOR being one of the viewer's learned `preferredAuthors`, or
 *   - FRESHNESS: the post is younger than the grace window (cold-start supply).
 * Pure; neutral (`false`) for an anonymous / behavior-less viewer.
 */
export function matchesViewerInterests(
  post: CandidatePost,
  ctx: FeedEngineContext,
  cfg: { strongTopicWeight: number; freshnessGraceMs: number },
): boolean {
  const behavior = ctx.userBehavior;

  const preferredTopics = behavior?.preferredTopics ?? [];
  if (preferredTopics.length > 0) {
    const strongTopics = new Set(
      preferredTopics
        .filter((t) => typeof t.topic === 'string' && t.weight > cfg.strongTopicWeight)
        .map((t) => t.topic.toLowerCase()),
    );
    if (strongTopics.size > 0 && classificationTopics(post).some((t) => strongTopics.has(t))) {
      return true;
    }
  }

  const authorId = post.oxyUserId;
  if (authorId) {
    const preferredAuthors = behavior?.preferredAuthors ?? [];
    if (preferredAuthors.some((a) => a.authorId === authorId)) {
      return true;
    }
  }

  const created = new Date((post.createdAt as Date | string | undefined) ?? 0).getTime();
  return Number.isFinite(created) && Date.now() - created <= cfg.freshnessGraceMs;
}

/**
 * `nativeEngagementOrMatch` predicate (PURE) — keep a discovery candidate when it
 * has EITHER real native (non-federated) traction OR a strong personalization
 * match. Federated Announces (`federatedBoostsCount`) do NOT count toward the
 * native floor — that is the whole point of tracking them separately — so a burst
 * of remote boosts can no longer smuggle an off-interest post into the feed.
 *
 * @returns `true` to KEEP the post, `false` to reject it.
 */
export function passesNativeEngagementOrMatch(
  post: CandidatePost,
  ctx: FeedEngineContext,
  cfg: { minNativeEngagement: number; strongTopicWeight: number; freshnessGraceMs: number },
): boolean {
  if (nativeEngagementCount(post) >= cfg.minNativeEngagement) {
    return true;
  }
  return matchesViewerInterests(post, ctx, cfg);
}

/**
 * `lowEffortGate`: hard-reject objective low-effort junk (see
 * {@link passesLowEffortGate}). Thresholds come from filter params, defaulting to
 * `MtnConfig.feed.discoveryGate`. INTERNAL gate module (not surfaced in the
 * builder — Phase 4B adds the user-facing `noLowEffort` variant).
 */
export const lowEffortGateFilter: FilterModule = {
  id: 'lowEffortGate',
  kind: 'filter',
  userComposable: false,
  keep: (post, ctx, params) => {
    const tuning = gateTuning(ctx, params, 'lowEffortGate');
    if (tuning?.enabled === false) return true;
    return passesLowEffortGate(post, {
      minMeaningfulTextLength: tuning?.minMeaningfulTextLength
        ?? numParam(params, 'minMeaningfulTextLength', DISCOVERY_GATE.minMeaningfulTextLength),
      spamRejectThreshold: numParam(params, 'spamRejectThreshold', DISCOVERY_GATE.spamRejectThreshold),
      qualityRejectThreshold: numParam(params, 'qualityRejectThreshold', DISCOVERY_GATE.qualityRejectThreshold),
    });
  },
};

/**
 * `nativeEngagement`: keep a discovery candidate with native traction OR a strong
 * personalization match (see {@link passesNativeEngagementOrMatch}). Thresholds
 * come from filter params, defaulting to `MtnConfig.feed.discoveryGate`. INTERNAL
 * gate module.
 */
export const nativeEngagementFilter: FilterModule = {
  id: 'nativeEngagement',
  kind: 'filter',
  userComposable: false,
  keep: (post, ctx, params) => {
    const tuning = gateTuning(ctx, params, 'nativeEngagement');
    if (tuning?.enabled === false) return true;
    return passesNativeEngagementOrMatch(post, ctx, {
      minNativeEngagement: tuning?.minNativeEngagement
        ?? numParam(params, 'minNativeEngagement', DISCOVERY_GATE.minNativeEngagement),
      strongTopicWeight: numParam(params, 'strongTopicWeight', DISCOVERY_GATE.strongTopicWeight),
      freshnessGraceMs: numParam(params, 'freshnessGraceMs', DISCOVERY_GATE.freshnessGraceMs),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Phase 4B USER-COMPOSABLE quality/effort/link/bot modules. Same PURE predicates
// as the For You gate (F4/F6), re-exposed as first-class custom-feed filters with
// typed params. `minQuality` doubles as a For You gate module (its threshold then
// comes from the viewer's `feedTuning.forYou.minQuality` via {@link gateTuning}).
// ─────────────────────────────────────────────────────────────────────────

/**
 * `minQuality`: keep only posts whose TRUSTED classification quality
 * ({@link readTrustedScores}) is at or above `params.minQuality` (0..1). NEUTRAL
 * when the post carries no trusted score (the all-zeros default or a stale
 * baseline → `null`), so the feed can never empty merely because scores are
 * absent. A user-composable QUALITY floor for custom feeds; ALSO wired into the
 * For You gate, where the threshold/toggle come from `feedTuning.forYou.minQuality`
 * (default: no threshold ⇒ neutral, i.e. opt-in).
 */
export const minQualityFilter: FilterModule = {
  id: 'minQuality',
  kind: 'filter',
  userComposable: true,
  keep: (post, ctx, params) => {
    const tuning = gateTuning(ctx, params, 'minQuality');
    if (tuning?.enabled === false) return true;
    const threshold = typeof tuning?.minQuality === 'number'
      ? tuning.minQuality
      : (typeof params.minQuality === 'number' ? params.minQuality : undefined);
    if (threshold === undefined) return true; // no floor set → neutral
    const scores = readTrustedScores(post);
    if (!scores) return true; // no trusted provenance → neutral
    return scores.quality >= threshold;
  },
};

/**
 * `noLowEffort`: drop OBJECTIVE low-effort posts — emoji-only / custom-emoji
 * shortcode-only / no-real-prose (via {@link detectLowEffort}) — UNLESS the post
 * carries media or a poll (which rescues a low-text post). Optionally also drops
 * emoji-HEAVY posts when `params.maxEmojiRatio` (0..1) is set: a post whose emoji
 * share of its visible glyphs (`emoji / (emoji + realLetters)`) exceeds the ratio
 * and carries no media/poll. Threshold `params.minMeaningfulTextLength` defaults
 * to the discovery-gate config. Thin wrapper over the F6 detector — no new parsing.
 */
export const noLowEffortFilter: FilterModule = {
  id: 'noLowEffort',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const minMeaningful = numParam(params, 'minMeaningfulTextLength', DISCOVERY_GATE.minMeaningfulTextLength);
    const result = detectLowEffort(contentText(post), { minRealTextLength: minMeaningful });

    // No meaningful prose AND nothing visual to rescue it → objective junk.
    if ((result.isNoRealText || result.shortcodeOnly || result.emojiOnly) && !hasMediaOrPoll(post)) {
      return false;
    }

    // Optional emoji-heavy rejection (text-only; media/poll rescues it).
    const maxEmojiRatio = typeof params.maxEmojiRatio === 'number' ? params.maxEmojiRatio : undefined;
    if (maxEmojiRatio !== undefined && !hasMediaOrPoll(post)) {
      const visibleGlyphs = result.emojiCount + result.realTextLength;
      if (visibleGlyphs > 0 && result.emojiCount / visibleGlyphs > maxEmojiRatio) {
        return false;
      }
    }
    return true;
  },
};

/**
 * `linkCount`: keep only posts whose number of cited/inlined links (via
 * {@link contentUrls}) is within `[params.minLinks, params.maxLinks]`. Either
 * bound is optional; with neither set the filter is a no-op. Complements the
 * boolean `hasLink`.
 */
export const linkCountFilter: FilterModule = {
  id: 'linkCount',
  kind: 'filter',
  userComposable: true,
  keep: (post, _ctx, params) => {
    const min = typeof params.minLinks === 'number' ? params.minLinks : undefined;
    const max = typeof params.maxLinks === 'number' ? params.maxLinks : undefined;
    if (min === undefined && max === undefined) return true;
    const count = contentUrls(post).length;
    if (min !== undefined && count < min) return false;
    if (max !== undefined && count > max) return false;
    return true;
  },
};

/**
 * `noBots`: drop RSS/bridge MIRRORS and link-only news bots (via
 * {@link detectBotShape}). `isRssMirror` reads the federated instance host
 * ({@link federationHost}); `isLinkOnlyNewsBot` reads the text shape (leading link
 * + boilerplate hashtag tail) so it fires even on native/unknown-origin
 * candidates. Uses the SAME visible-prose definition as ingest ({@link visibleText})
 * and the shared `SPAM_QUALITY_CONFIG.bot` thresholds. Toggle (no params).
 */
export const noBotsFilter: FilterModule = {
  id: 'noBots',
  kind: 'filter',
  userComposable: true,
  keep: (post) => {
    const rawText = contentText(post);
    const shape = detectBotShape(
      {
        rawText,
        visible: visibleText(rawText),
        urlCount: countTextUrls(rawText),
        hashtagCount: (field<string[]>(post, 'hashtags') ?? []).length,
      },
      { isFederated: isFederated(post), instanceDomain: federationHost(post) },
      SPAM_QUALITY_CONFIG.bot,
    );
    return !shape.isRssMirror && !shape.isLinkOnlyNewsBot;
  },
};

export const filterModules: FilterModule[] = [
  safetyFilter,
  lowEffortGateFilter,
  nativeEngagementFilter,
  minQualityFilter,
  noLowEffortFilter,
  linkCountFilter,
  noBotsFilter,
  languagePreferenceFilter,
  muteBlockFilter,
  noBoostsFilter,
  noRepliesFilter,
  mediaOnlyFilter,
  videoOnlyFilter,
  dedupeFilter,
  recencyWindowFilter,
  excludeFollowingFilter,
  hasImageFilter,
  hasGifFilter,
  hasPollFilter,
  hasLinkFilter,
  hasAltTextFilter,
  textOnlyFilter,
  excludeQuotesFilter,
  originalOnlyFilter,
  onlyRepliesFilter,
  minEngagementFilter,
  maxLengthFilter,
  minLengthFilter,
  domainAllowlistFilter,
  domainDenylistFilter,
  customMuteWordsFilter,
  keywordDenylistFilter,
  languageStrictFilter,
  localOnlyFilter,
  federatedOnlyFilter,
  instanceAllowlistFilter,
  instanceDenylistFilter,
  topicAllowlistFilter,
  topicDenylistFilter,
  sentimentFilter,
  onlySensitiveFilter,
  excludeSensitiveFilter,
  verifiedOnlyFilter,
  verifiedFollowsOnlyFilter,
  minFollowersFilter,
  minAccountAgeFilter,
];

export function registerFilterModules(registry: FeedModuleRegistry = feedModuleRegistry): void {
  for (const module of filterModules) registry.register(module);
}
