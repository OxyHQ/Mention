/**
 * The text-match predicate for each searchable non-post table, in ONE place.
 *
 * ## Why the predicate is the thing that gets shared, and not the query
 *
 * Each of these is a coarse, index-servable prefilter AND the exact per-column
 * `ILIKE`s as a recheck. Both halves are load-bearing and each has a failure
 * mode the other cannot catch:
 *
 * - Drop the prefilter and the answers stay CORRECT while the query silently
 *   goes back to a sequential scan. Nothing fails; only latency changes, which
 *   is the regression `__tests__/db/searchIndexes.test.ts` exists for.
 * - Drop the recheck and the query gets FASTER and quietly wrong, admitting
 *   rows that match only across a column boundary (`"alice bob"` matching the
 *   concatenation of a title and a description that share neither).
 *
 * A predicate written twice — once in a route, once in the overview — is two
 * places for one of those halves to go missing. The projection, the visibility
 * scope and the page window are NOT shared, deliberately: those genuinely
 * differ per surface (the overview wants five public rows, the tab wants a
 * paged window including the viewer's private ones), and forcing them through
 * one function would mean a parameter for every difference.
 *
 * The prefilter expressions are imported from the schema, never restated, so
 * the query and the index it is written against cannot drift.
 *
 * ## Why `utils/` and not `db/`
 *
 * These perform no I/O and hold no state; they only build `SQL` fragments, so
 * they are the same kind of thing as `utils/feedQueryBuilder.ts` (and as Oxy's
 * `utils/profileQuery.ts`, whose docblock gives the identical reason). The
 * placement is also enforced: `scripts/validate-architecture-boundaries.mjs`
 * refuses a route reaching into `db/`, because a route must go through a
 * service that owns the repository call — and it caught the first draft of this
 * file living under `db/search/`.
 */

import { and, ilike, or, sql, type SQL } from 'drizzle-orm';
import { qualified } from '@oxy.so/db';

import { ACCOUNT_LISTS_SEARCH_TEXT, accountLists, starterPacks, STARTER_PACKS_SEARCH_TEXT } from '../db/schema/lists';
import { customFeeds } from '../db/schema/feeds';
import { likeContains } from '@oxy.so/utils/sql';

/**
 * `keywords` is `text[]`, so "any element matches" is an EXISTS over `unnest`.
 *
 * Kept here beside the predicate that uses it rather than imported from the
 * route: it is part of what "a feed matches this term" means.
 */
function keywordMatches(pattern: string): SQL {
  return sql`exists (
    select 1 from unnest(${qualified(customFeeds.keywords)}) as element
    where element ilike ${pattern}
  )`;
}

/** `GET /lists?search=` — title and description, substring. */
export function accountListSearchPredicate(term: string): SQL {
  const pattern = likeContains(term);
  return and(
    // Written against the very expression `account_lists_search_trgm_gin` is
    // built on, so Postgres answers it from the index instead of scanning.
    // Lower-cased pattern because the indexed expression is `lower(...)`.
    sql`${ACCOUNT_LISTS_SEARCH_TEXT} like ${pattern.toLowerCase()}`,
    or(ilike(accountLists.title, pattern), ilike(accountLists.description, pattern)),
  ) as SQL;
}

/** `GET /starter-packs?search=` — name and description, substring. */
export function starterPackSearchPredicate(term: string): SQL {
  const pattern = likeContains(term);
  return and(
    sql`${STARTER_PACKS_SEARCH_TEXT} like ${pattern.toLowerCase()}`,
    or(ilike(starterPacks.name, pattern), ilike(starterPacks.description, pattern)),
  ) as SQL;
}

/** `GET /feeds?search=` — title, description and any keyword, substring. */
export function customFeedSearchPredicate(term: string): SQL {
  const pattern = likeContains(term);
  return and(
    // Through the IMMUTABLE wrapper the index is built on. The wrapper exists
    // because `array_to_string` is only STABLE and cannot appear in an index
    // expression — see `drizzle/0040`.
    sql`custom_feeds_search_text(${customFeeds.title}, ${customFeeds.description}, ${customFeeds.keywords}) like ${pattern.toLowerCase()}`,
    or(
      ilike(customFeeds.title, pattern),
      ilike(customFeeds.description, pattern),
      keywordMatches(pattern),
    ),
  ) as SQL;
}
