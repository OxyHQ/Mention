/**
 * Finding a channel by name — the entity, not its posts.
 *
 * Channel POSTS already surface on every discovery surface as ordinary posts;
 * this is how the DESTINATION itself becomes findable, which is what a reader who
 * heard a channel's name actually wants.
 *
 * Pure of Express on purpose, the way `mtn/feed/interstitials/interstitialTelemetry.ts`
 * is: the search controller cannot be unit-tested in isolation, and the ranking
 * below is the part worth testing.
 *
 * THREE properties are load-bearing, and each one is a rule somebody relaxes later:
 *
 *  1. **`visibility` is a WHERE clause, never a post-filter.** `ChannelVisibility`
 *     has one value today, so a filter written after the query would look correct
 *     and stay correct until the day a second value exists — at which point the
 *     omission leaks rather than fails. Asking the database means a restricted
 *     tier can never be returned by a page this code forgot to re-audit.
 *  2. **The term is LIKE-escaped**, and the alphabet changed with the port: Mongo
 *     needed regex metacharacters escaped, Postgres needs `%`, `_` and `\`. An
 *     unescaped `%` is not a ReDoS here, it is a match-everything wildcard — the
 *     same hole in a different spelling, which is why the escape moved rather
 *     than being dropped as "a Mongo concern".
 *  3. **The sort is TOTAL** — rank, then followers, then `id`. Offset paging over
 *     a partial order duplicates and drops rows; `id` is what makes the order
 *     total, exactly as `routes/lists.ts` breaks its `updated_at` ties. Note the
 *     tiebreak orders ObjectId hex and uuid v7 in ONE text collation, so it is
 *     stable but not chronological — nothing here reads it as a time.
 *
 * The three `ilike '%…%'` predicates cannot use a b-tree index and scan
 * `channels`. That is what the Mongo `$regex` did too, the directory is small
 * and bounded by {@link MAX_CHANNEL_SEARCH_OFFSET}, and the statement timeout
 * below is what bounds the cost either way.
 */

import { and, asc, desc, eq, ilike, notInArray, or, sql } from 'drizzle-orm';
import {
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  type Channel as ChannelDTO,
} from '@mention/shared-types';
import { getDb } from '../db/postgres';
import { channels } from '../db/schema/channels';
import { serializeChannel } from './channelDto';
import { config } from '../config';

/**
 * How deep a caller may page. An `OFFSET` is linear in the rows it discards, so
 * an unbounded offset is a cheap way to make the server walk the whole table;
 * nobody scrolls past this many name matches, and the alternative — a keyset over
 * a COMPUTED rank — would have to encode the rank in the cursor and re-derive it
 * identically on every page.
 */
export const MAX_CHANNEL_SEARCH_OFFSET = 500;

/**
 * Longest term worth matching: the longest field it is matched against. Escaping
 * already leaves a literal pattern, but a term longer than every field it could
 * match is work that can only ever return nothing.
 */
const MAX_CHANNEL_SEARCH_TERM_LENGTH = MAX_CHANNEL_DESCRIPTION_LENGTH;

/**
 * Relevance tiers, ascending — the `order by` reads them as an ordinary number,
 * so "better" is SMALLER.
 *
 * The one ordering the product actually promises is that somebody who typed a
 * channel's exact handle gets that channel first: a handle is unique and
 * unambiguous, so an exact hit is an answer rather than a candidate, and losing
 * it to a more-followed channel that merely mentions the word in its description
 * is the failure this ranking exists to prevent. Below that, a name match beats a
 * blurb match, and `follower_count` breaks ties.
 */
export const CHANNEL_SEARCH_RANK = {
  exactHandle: 0,
  handle: 1,
  title: 2,
  description: 3,
} as const;

/** A page of channel results, and whether another one exists. */
export interface ChannelSearchPage {
  items: ChannelDTO[];
  hasMore: boolean;
}

export interface ChannelSearchOptions {
  limit: number;
  offset: number;
  /**
   * Channels to leave out — the directory's `excludeFollowed` set, which the
   * search path honours too so a documented query parameter does not quietly
   * stop meaning anything the moment a search term is added next to it.
   */
  excludeChannelIds?: readonly string[];
}

/**
 * Escape the characters `LIKE` treats as wildcards.
 *
 * The Mongo version escaped REGEX metacharacters, which is the wrong alphabet
 * here: `%` and `_` are what `ILIKE` reads as patterns, and leaving them live
 * turns the search box into a way to match every channel in the table.
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Public channels whose handle, title or description contains `rawTerm`, best
 * match first.
 *
 * A blank term returns nothing rather than the whole directory: `GET /channels`
 * is the directory, and a search box that has not been typed in has not asked a
 * question.
 */
export async function searchChannels(
  rawTerm: string,
  { limit, offset, excludeChannelIds }: ChannelSearchOptions,
): Promise<ChannelSearchPage> {
  const term = rawTerm.trim().slice(0, MAX_CHANNEL_SEARCH_TERM_LENGTH);
  if (term.length === 0) {
    return { items: [], hasMore: false };
  }

  const pattern = likeContains(term);
  // `handle_lower` is stored canonical-lowercase, so the exact tier compares
  // against the lowercased term — only a stored handle can ever match it.
  const exactHandle = term.toLowerCase();

  // ONE expression, used in both the projection and the `order by`, so the rank
  // a caller can read and the rank the page is sorted by cannot become two
  // different definitions of relevance. It is inlined into both positions rather
  // than referenced by its output alias, which Postgres accepts in `order by`
  // only for a bare alias and would silently stop resolving if the projection
  // were ever wrapped.
  //
  // `handle_lower` and `title` are NOT NULL, so no arm can evaluate to NULL and
  // fall through to the `else`. `description` is nullable and deliberately has
  // no arm — the `else` IS the description tier, reached only by a row the
  // `where` already accepted.
  const searchRank = sql<number>`
    case
      when ${channels.handleLower} = ${exactHandle} then ${CHANNEL_SEARCH_RANK.exactHandle}
      when ${channels.handleLower} ilike ${pattern} then ${CHANNEL_SEARCH_RANK.handle}
      when ${channels.title} ilike ${pattern} then ${CHANNEL_SEARCH_RANK.title}
      else ${CHANNEL_SEARCH_RANK.description}
    end
  `;

  const where = and(
    eq(channels.visibility, 'public'),
    ...(excludeChannelIds && excludeChannelIds.length > 0
      ? [notInArray(channels.id, [...excludeChannelIds])]
      : []),
    // A disjunction is what "matches any of three fields" IS, and it is an
    // ordinary `or(...)` inside one `and(...)` here — the rule that forbids a
    // disjunction applies to the feed match objects `ChronoCursor.applyToQuery`
    // ASSIGNS into, and is stated here so nobody carries it over by reflex.
    or(
      ilike(channels.handleLower, pattern),
      ilike(channels.title, pattern),
      ilike(channels.description, pattern),
    ),
  );

  // The replacement for Mongoose's `.option({ maxTimeMS })`: `SET LOCAL` needs a
  // transaction, and `set_config(..., true)` is the spelling that takes a bind
  // parameter (`SET` itself does not). Same shape as
  // `controllers/statistics.controller.ts`.
  const matched = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(config.search.maxTimeMS)}, true)`,
    );
    return tx
      .select({ channel: channels, searchRank })
      .from(channels)
      .where(where)
      .orderBy(asc(searchRank), desc(channels.followerCount), desc(channels.id))
      .offset(offset)
      // One extra row answers `hasMore` without a second count over the same
      // predicate.
      .limit(limit + 1);
  });

  const hasMore = matched.length > limit;
  const page = hasMore ? matched.slice(0, limit) : matched;

  return { items: page.map((row) => serializeChannel(row.channel)), hasMore };
}
