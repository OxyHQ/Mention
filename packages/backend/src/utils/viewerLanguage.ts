import type { Request } from 'express';
import { canonicalizeLanguageTag } from '@mention/shared-types';
import { getUserLanguages } from '@oxy.so/core';
import { config } from '../config';
import { createCache } from './cache';
import { logger } from './logger';
import type { OxyClient } from './privacyHelpers';
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
 * The viewer's Oxy account locales sit between the two. They are not on the
 * request: {@link loadViewerLanguages} reads them, per viewer, from Oxy.
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
 * The full variant-resolution ladder, most-preferred first: an explicit `?lang`,
 * then the viewer's Oxy account locales (primary first — what they DECLARED),
 * then `Accept-Language` (what their device happens to say). Without account
 * locales (an anonymous reader, or a consumer with no account rung: a
 * readability set, a default for a note's language) it is `?lang` then
 * `Accept-Language`.
 */
export function languageLadder(
  request: RequestLanguages | undefined,
  accountLanguages: readonly string[] = [],
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

/**
 * The viewer's account locales, cached per viewer id. Private to the viewer —
 * read with their own credential and only ever served back to requests for that
 * same id — and never part of the per-author public identity cache, which
 * cannot hold them (Oxy's public profile has no `languages`).
 *
 * FRESHNESS IS PUSHED, not polled: oxy-api broadcasts `oxy:user:invalidate`
 * with the user's id on every profile write, and
 * `services/userInvalidationSubscriber` drops this entry
 * ({@link invalidateViewerLanguages}), so a reorder applies on the reader's next
 * request. The TTL is only the safety net for a lost broadcast, the same bound
 * the identity cache uses.
 */
const VIEWER_LANGUAGES_PREFIX = 'viewerlanguages:v1:';
const VIEWER_LANGUAGES_TTL_SECONDS = config.cache.userSummaryTtlSeconds;

const viewerLanguagesCache = createCache({
  name: 'ViewerLanguagesCache',
  ttlSeconds: VIEWER_LANGUAGES_TTL_SECONDS,
});

const viewerLanguagesKey = (userId: string): string => `${VIEWER_LANGUAGES_PREFIX}${userId}`;

/**
 * The viewer's Oxy account locales, primary first — the account rung of
 * {@link languageLadder}, and the ONE reader of it: the feed context and post
 * hydration both come through here, so a warm viewer costs no Oxy call on any
 * surface.
 *
 * A miss reads Oxy's OWNER profile (`users.me()`) with this request's
 * credential. Only an answer for this very viewer is cached; a failed read, a
 * client that cannot read the owner profile, or a profile for someone else
 * yields `[]` (the ladder falls through to the request's languages) and is not
 * cached, so it is retried on the next request.
 */
export async function loadViewerLanguages(
  userId: string | undefined,
  oxyClient?: OxyClient,
): Promise<string[]> {
  if (!userId) return [];
  const languages = await viewerLanguagesCache.getOrCompute(
    viewerLanguagesKey(userId),
    () => readOwnerLanguages(userId, oxyClient),
    { ttlSecondsFor: (value) => (value === null ? null : VIEWER_LANGUAGES_TTL_SECONDS) },
  );
  return languages ?? [];
}

/** Drop the cached locales of these viewers, so their next request re-reads Oxy. */
export async function invalidateViewerLanguages(userIds: string[]): Promise<void> {
  await viewerLanguagesCache.delete(userIds.map(viewerLanguagesKey));
}

/** The owner profile's locales, or `null` when this read cannot vouch for them. */
async function readOwnerLanguages(
  userId: string,
  oxyClient: OxyClient | undefined,
): Promise<string[] | null> {
  if (!oxyClient?.users) return null;
  try {
    const user = await oxyClient.users.me();
    return user.id === userId ? getUserLanguages(user) : null;
  } catch (error) {
    logger.warn('[viewerLanguage] Failed to load viewer languages', error);
    return null;
  }
}
