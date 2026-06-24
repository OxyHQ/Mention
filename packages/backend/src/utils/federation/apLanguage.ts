/**
 * Pure helper to extract a post language from an ActivityPub/Mastodon object.
 *
 * Mastodon (and many AP servers) advertise the status language in one of two
 * places on a `Note`/`Create` object:
 *   - a top-level `language` string (BCP-47, e.g. `"en"`, `"pt-BR"`), and/or
 *   - a `contentMap` object keyed by BCP-47 language tag whose value is the
 *     localized HTML content (e.g. `{ "es": "<p>hola</p>" }`).
 *
 * This helper normalizes either source to a plain ISO 639-1 primary subtag
 * (lowercased, region/script stripped — `"pt-BR"` → `"pt"`). It is pure and
 * has no I/O so it is trivially unit-testable; wiring it into the federation
 * ingest paths is done separately (P2).
 */

/** Length of an ISO 639-1 primary language subtag. */
const ISO_639_1_LENGTH = 2;

/**
 * Normalizes a BCP-47 language tag to its ISO 639-1 primary subtag, or returns
 * `undefined` when the input is not a usable 2-letter primary subtag. Region,
 * script, and extension subtags are discarded (`"zh-Hant-TW"` → `"zh"`).
 */
function toIso6391(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const primary = tag.trim().toLowerCase().split('-')[0];
  if (primary.length !== ISO_639_1_LENGTH) return undefined;
  if (!/^[a-z]{2}$/.test(primary)) return undefined;
  return primary;
}

/**
 * Extracts the best-effort ISO 639-1 language from an AP object. Prefers the
 * explicit top-level `language` field; falls back to the single key of
 * `contentMap` when it is unambiguous (exactly one language present). Returns
 * `undefined` when neither yields a usable code.
 *
 * AP objects are untyped JSON, so the parameter is a record of unknown values
 * and every field is narrowed defensively (no unchecked casts).
 */
export function extractApLanguage(object: Record<string, unknown> | null | undefined): string | undefined {
  if (!object || typeof object !== 'object') return undefined;

  const fromLanguage = toIso6391(object.language);
  if (fromLanguage) return fromLanguage;

  const contentMap = object.contentMap;
  if (contentMap && typeof contentMap === 'object' && !Array.isArray(contentMap)) {
    const keys = Object.keys(contentMap);
    // Only trust contentMap when it is unambiguous (a single localized variant).
    if (keys.length === 1) {
      return toIso6391(keys[0]);
    }
  }

  return undefined;
}

/**
 * Extracts the FULL set of ISO 639-1 languages declared on an AP object: the
 * top-level `language` field PLUS every `contentMap` key (a multi-key
 * `contentMap` declares one localized variant per language). Unlike
 * {@link extractApLanguage} — which conservatively ignores an ambiguous multi-key
 * `contentMap` — this returns ALL declared languages so a bilingual Mastodon
 * status records each one.
 *
 * The result is normalized to ISO 639-1 primary subtags (`"pt-BR"` → `"pt"`),
 * deduped (first-seen order: the top-level `language` leads, then `contentMap`
 * keys in object order), and excludes any value that is not a usable 2-letter
 * code. Returns `[]` when neither source yields a usable code. Pure / no I/O.
 */
export function extractApLanguages(object: Record<string, unknown> | null | undefined): string[] {
  if (!object || typeof object !== 'object') return [];

  const codes: string[] = [];

  const fromLanguage = toIso6391(object.language);
  if (fromLanguage) codes.push(fromLanguage);

  const contentMap = object.contentMap;
  if (contentMap && typeof contentMap === 'object' && !Array.isArray(contentMap)) {
    for (const key of Object.keys(contentMap)) {
      const code = toIso6391(key);
      if (code) codes.push(code);
    }
  }

  return [...new Set(codes)];
}
