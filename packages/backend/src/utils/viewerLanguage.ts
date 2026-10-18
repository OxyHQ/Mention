import type { Request } from 'express';
import { canonicalizeLanguageTag } from '@mention/shared-types';
import { queryString } from './queryParams';

/**
 * How many `Accept-Language` entries are considered. A browser sends a handful;
 * the header is attacker-controlled, so the list a request can push into the
 * variant ladder is bounded rather than unbounded.
 */
const MAX_ACCEPT_LANGUAGE_TAGS = 10;

/**
 * The language preference a REQUEST carries, split by how much it is worth:
 *
 *   - `explicit` — `?lang=`, a language the reader picked on this request. It
 *     outranks everything, the account included.
 *   - `accepted` — `Accept-Language`, the browser/app locale, already
 *     quality-ordered by Express (`req.acceptsLanguages()` sorts by `q`). A
 *     device default the reader never chose for Mention, so for a signed-in
 *     reader it ranks BELOW the languages their Oxy account declares — a Catalan
 *     browser must not outrank a Spanish primary. See {@link languageLadder}.
 *
 * The viewer's Oxy account locales sit between the two, but they are resolved
 * server-side inside hydration (from the Redis-cached identity), not here — this
 * helper is synchronous and sees only the request.
 *
 * Every tag is canonicalized, so a malformed header entry (or a wildcard `*`) is
 * dropped instead of reaching the resolver; `accepted` never repeats `explicit`.
 */
export interface RequestLanguages {
  explicit?: string;
  accepted: string[];
}

/** Read {@link RequestLanguages} off a request. */
export function requestLanguageCandidates(req: Request): RequestLanguages {
  const explicit = canonicalizeLanguageTag(queryString(req.query?.lang)) ?? undefined;
  const accepted: string[] = [];

  // `acceptsLanguages` is an Express helper, not a property of the HTTP request:
  // it is absent whenever this runs against a request that did not come through
  // the Express router. A language preference is BEST-EFFORT everywhere else in
  // this pipeline — `loadViewerLanguages` catches, `viewerLanguageSql` returns
  // `undefined`, and both consumers read an empty set as "unknown, filter
  // nothing" — so the one path that could turn an unreadable preference into a
  // 500 for the whole feed has to degrade the same way.
  const header = typeof req.acceptsLanguages === 'function' ? req.acceptsLanguages() : [];
  for (const raw of header.slice(0, MAX_ACCEPT_LANGUAGE_TAGS)) {
    const tag = canonicalizeLanguageTag(raw);
    if (tag && tag !== explicit && !accepted.includes(tag)) {
      accepted.push(tag);
    }
  }

  return explicit ? { explicit, accepted } : { accepted };
}

/**
 * The request's languages as ONE list, `?lang` first — for consumers that have
 * no account rung to slot between the two (a readability SET, an anonymous
 * reader, a default for a note's language).
 */
export function requestLanguageList(languages: RequestLanguages | undefined): string[] {
  if (!languages) return [];
  return languages.explicit ? [languages.explicit, ...languages.accepted] : [...languages.accepted];
}

/**
 * The full variant-resolution ladder, most-preferred first: an explicit `?lang`,
 * then the viewer's Oxy account locales (primary first — what they DECLARED),
 * then `Accept-Language` (what their device happens to say). An anonymous
 * reader has no account rung and gets `?lang` then `Accept-Language`.
 */
export function languageLadder(
  request: RequestLanguages | undefined,
  accountLanguages: readonly string[],
): string[] {
  const ladder: string[] = [];
  for (const tag of [
    ...(request?.explicit ? [request.explicit] : []),
    ...accountLanguages,
    ...(request?.accepted ?? []),
  ]) {
    if (!ladder.includes(tag)) ladder.push(tag);
  }
  return ladder;
}
