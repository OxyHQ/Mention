/**
 * Language tags for multilingual post content.
 *
 * TWO LAYERS, deliberately separate — conflating them is where multilingual
 * systems break:
 *
 * - **CONTENT is tagged in BCP-47** (`es-ES`, `pt-BR`). What an author wrote is
 *   genuinely regional: `pt-BR` and `pt-PT` are not the same text, and neither
 *   are `es-ES` and `es-419`. The protocols agree — ActivityPub `contentMap`
 *   keys and Bluesky `langs` are BCP-47 language tags.
 *
 * - **MATCHING happens on the BASE subtag** (`es`, `en`). Who a post is shown to
 *   must not be fragmented by region: a reader in `es-MX` has to see a post
 *   written in `es-ES`. The feed's classification array and its multikey index
 *   are base codes for exactly this reason. Letting the region reach the ranking
 *   layer would be a bug wearing the costume of precision.
 *
 * Everything that stores or compares a language tag goes through this module.
 * No raw strings into the model.
 *
 * ---
 *
 * **Why this parses BCP-47 by hand instead of using `Intl.Locale`.**
 *
 * Two reasons, and the second is the important one:
 *
 * 1. `Intl.Locale` does not exist in Hermes (React Native's engine ships only
 *    Collator / DateTimeFormat / NumberFormat / getCanonicalLocales). An
 *    implementation built on it returns `null` for every tag on iOS and Android
 *    while working perfectly in a browser — it would pass every web test and be
 *    silently broken on device.
 *
 * 2. Even where `Intl.Locale` exists, using it here would mean the SERVER
 *    canonicalizes tags with one implementation and the CLIENT compares them
 *    with another. Canonicalization has to be byte-identical on both sides or
 *    equality checks quietly stop matching. One deterministic implementation,
 *    identical on every engine, is the only version of this that is correct.
 */

/** Maximum author-written variants on one post. */
export const MAX_AUTHOR_VARIANTS = 3;

/**
 * BCP-47 language tag, restricted to the subtags content actually needs:
 * language, optional script, optional region, optional variants.
 *
 * Extensions (`-u-…`, `-x-…`) and grandfathered tags are deliberately REJECTED:
 * they carry no meaning for "what language is this text written in", and
 * accepting them would mean storing two tags that must compare equal but don't.
 */
const BCP47_PATTERN = new RegExp(
  '^'
  + '([a-z]{2,3}|[a-z]{5,8})'        // language ('es', 'ast'); 4 letters is a script, not a language
  + '(?:-([a-z]{4}))?'               // script  ('Hant')
  + '(?:-([a-z]{2}|\\d{3}))?'        // region  ('ES', '419')
  + '((?:-(?:[\\da-z]{5,8}|\\d[\\da-z]{3}))*)' // variants ('valencia', '1996')
  + '$',
  'i',
);

/** `hant` → `Hant`. Script subtags are title case by convention. */
function titleCase(subtag: string): string {
  return subtag.charAt(0).toUpperCase() + subtag.slice(1).toLowerCase();
}

/**
 * Canonicalize a BCP-47 language tag: `es-es` → `es-ES`, `ZH-hant-tw` →
 * `zh-Hant-TW`, `pt_BR` → `pt-BR`.
 *
 * Returns `null` for anything that is not a structurally valid tag, so an
 * invalid value is REJECTED at the boundary rather than stored and tripped over
 * later.
 */
export function canonicalizeLanguageTag(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;

  // Underscores are a common serialization of locales (`pt_BR`); normalize them
  // before matching rather than rejecting an otherwise-valid tag.
  const trimmed = tag.trim().replace(/_/g, '-');
  if (trimmed.length === 0) return null;

  const match = BCP47_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, language, script, region, variants] = match;
  if (!language) return null;

  let canonical = language.toLowerCase();
  if (script) canonical += `-${titleCase(script)}`;
  if (region) canonical += `-${region.toUpperCase()}`;
  if (variants) canonical += variants.toLowerCase();

  return canonical;
}

/**
 * The base (primary) subtag of a language tag: `es-ES` → `es`, `es` → `es`.
 *
 * This is the value the classifier, the ranking signals and the multikey index
 * speak. Returns `null` when the tag is not valid.
 */
export function toBaseLanguage(tag: unknown): string | null {
  const canonical = canonicalizeLanguageTag(tag);
  if (canonical === null) return null;
  const base = canonical.split('-')[0];
  return base ? base.toLowerCase() : null;
}

/** Whether two language tags share a base subtag (`es-MX` ≈ `es-ES`). */
export function sameBaseLanguage(a: unknown, b: unknown): boolean {
  const baseA = toBaseLanguage(a);
  const baseB = toBaseLanguage(b);
  return baseA !== null && baseA === baseB;
}

/**
 * The deduped base subtags of a list of tags, order preserved (primary first).
 * This is what a post DECLARES to the classifier and to federation.
 */
export function toBaseLanguages(tags: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const base = toBaseLanguage(tag);
    if (base !== null) seen.add(base);
  }
  return [...seen];
}
