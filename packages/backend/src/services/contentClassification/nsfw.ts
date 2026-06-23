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
 */
export function isNsfwHashtag(hashtag: string | null | undefined): boolean {
  const slug = normalizeHashtagSlug(hashtag);
  return slug.length > 0 && NSFW_HASHTAGS.has(slug);
}

/**
 * The minimal post shape this module reads to decide sensitivity. A lean Mongo
 * document carrying any of the sensitive flags and/or `hashtags` satisfies it;
 * every field is optional so it works for native, federated, baselined, and
 * not-yet-classified posts alike.
 */
export interface SensitivePostShape {
  hashtags?: string[];
  postClassification?: { sensitive?: boolean | null };
  metadata?: { isSensitive?: boolean | null };
  federation?: { sensitive?: boolean | null };
}

/**
 * Whether a post is sensitive/NSFW and therefore must be kept OUT of the curated
 * For You feed and the ranked discovery surfaces. A post is sensitive when ANY
 * of these hold:
 *   - the deterministic/AI classifier flagged it (`postClassification.sensitive`),
 *   - the app metadata flag is set (`metadata.isSensitive`),
 *   - the federating source flagged it (`federation.sensitive`), or
 *   - it carries an NSFW/adult hashtag ({@link isNsfwHashtag}).
 *
 * This is the single in-memory counterpart to the Mongo `$ne:true` exclusions, so
 * every surface (candidate merge, popular fallback, ranking guard) agrees on what
 * "sensitive" means. NEUTRAL by default: a clean post returns `false`.
 */
export function isSensitivePost(post: SensitivePostShape | null | undefined): boolean {
  if (!post) return false;
  if (post.postClassification?.sensitive === true) return true;
  if (post.metadata?.isSensitive === true) return true;
  if (post.federation?.sensitive === true) return true;
  const tags = post.hashtags;
  if (Array.isArray(tags) && tags.some(isNsfwHashtag)) return true;
  return false;
}
