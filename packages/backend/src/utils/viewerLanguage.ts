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
 * The language preference a REQUEST carries, most-preferred first:
 *
 *   1. `?lang=` — the reader explicitly picked a language on the post.
 *   2. `Accept-Language` — the browser/app locale, already quality-ordered by
 *      Express (`req.acceptsLanguages()` sorts by `q`).
 *
 * The viewer's Oxy account locales are the NEXT rung of the ladder, but they are
 * resolved server-side inside hydration (from the Redis-cached identity), not
 * here — this helper is synchronous and sees only the request.
 *
 * Every tag is canonicalized, so a malformed header entry (or a wildcard `*`) is
 * dropped instead of reaching the resolver.
 */
export function requestLanguageCandidates(req: Request): string[] {
  const candidates: string[] = [];

  const explicit = canonicalizeLanguageTag(queryString(req.query?.lang));
  if (explicit) {
    candidates.push(explicit);
  }

  // `acceptsLanguages` is an Express helper, not a property of the HTTP request:
  // it is absent whenever this runs against a request that did not come through
  // the Express router. A language preference is BEST-EFFORT everywhere else in
  // this pipeline — `loadViewerLanguages` catches, `viewerLanguageSql` returns
  // `undefined`, and both consumers read an empty set as "unknown, filter
  // nothing" — so the one path that could turn an unreadable preference into a
  // 500 for the whole feed has to degrade the same way.
  const accepted = typeof req.acceptsLanguages === 'function' ? req.acceptsLanguages() : [];
  for (const raw of accepted.slice(0, MAX_ACCEPT_LANGUAGE_TAGS)) {
    const tag = canonicalizeLanguageTag(raw);
    if (tag && !candidates.includes(tag)) {
      candidates.push(tag);
    }
  }

  return candidates;
}
