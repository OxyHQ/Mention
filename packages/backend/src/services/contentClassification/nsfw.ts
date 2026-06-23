/**
 * Canonical NSFW / adult-content blocklist for the unified content-classification
 * system.
 *
 * This is the ONE source of truth for which hashtag slugs are considered
 * NSFW/adult so they can be kept OUT of discovery surfaces (trending today; For
 * You / Explore candidate generation later — P3c). It is plain, data-driven, and
 * extensible: add a slug to {@link NSFW_HASHTAGS} and every consumer inherits it.
 *
 * Slugs are stored already-normalized (lowercase, no leading `#`, no spaces) so
 * lookups are a single normalize + Set membership check.
 */

/**
 * Normalized NSFW/adult hashtag slugs. A sensible, conservative starter set
 * covering the most common adult-content tags. Extend as needed — keep entries
 * normalized (lowercase, no `#`).
 */
export const NSFW_HASHTAGS: ReadonlySet<string> = new Set([
  'nsfw',
  'adult',
  'adultcontent',
  'sexy',
  'sex',
  'erotic',
  'erotica',
  'porn',
  'porno',
  'pornography',
  'xxx',
  'nude',
  'nudes',
  'nudity',
  'naked',
  'onlyfans',
  'lewd',
  'hentai',
  'rule34',
  'r34',
  'boobs',
  'tits',
  'ass',
  'milf',
  'fetish',
  'bdsm',
  'camgirl',
  'cam',
  'escort',
  'nsfwart',
  'nsfwtwitter',
  '18plus',
]);

/**
 * Normalizes a raw hashtag to the slug form used by {@link NSFW_HASHTAGS}:
 * trims, lowercases, and strips a leading `#`. Returns an empty string for
 * nullish input.
 */
function normalizeHashtagSlug(hashtag: string | null | undefined): string {
  if (!hashtag) return '';
  return hashtag.trim().toLowerCase().replace(/^#+/, '');
}

/**
 * Whether a hashtag is on the NSFW/adult blocklist. Accepts any case and an
 * optional leading `#`; normalization is handled internally.
 *
 * This module owns the low-level blocklist PRIMITIVES ({@link NSFW_HASHTAGS} +
 * this predicate). The higher-level feed-safety gating — the post-level
 * sensitivity predicate (`isSfw`/`isSensitivePost`) and the canonical Mongo
 * exclusion clauses — lives in `mtn/feed/feedSafety.ts`, which composes these
 * primitives. Import feed safety from there, not from here.
 */
export function isNsfwHashtag(hashtag: string | null | undefined): boolean {
  const slug = normalizeHashtagSlug(hashtag);
  return slug.length > 0 && NSFW_HASHTAGS.has(slug);
}
