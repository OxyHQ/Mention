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
 *  1. **`visibility` is a MATCH CLAUSE, never a post-filter.** `ChannelVisibility`
 *     has one value today, so a filter written after the query would look correct
 *     and stay correct until the day a second value exists — at which point the
 *     omission leaks rather than fails. Asking Mongo means a restricted tier can
 *     never be returned by a page this code forgot to re-audit.
 *  2. **The term is regex-ESCAPED.** An unescaped user string in a Mongo regex is
 *     both an injection (`.*` matches every channel) and a ReDoS. Same
 *     `escapeRegex` precedent as `routes/lists.ts`.
 *  3. **The sort is TOTAL** — rank, then followers, then `_id`. Offset paging over
 *     a partial order duplicates and drops rows; `_id` is what makes the order
 *     total, exactly as `routes/lists.ts` breaks its `updatedAt` ties.
 */

import type mongoose from 'mongoose';
import type { PipelineStage } from 'mongoose';
import {
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  type Channel as ChannelDTO,
} from '@mention/shared-types';
import { Channel } from '../models/Channel';
import { serializeChannel, type ChannelLean } from './channelDto';
import { escapeRegex } from '../utils/textProcessing';
import { config } from '../config';

/**
 * How deep a caller may page. A `$skip` is linear in the rows it discards, so an
 * unbounded offset is a cheap way to make the server walk the whole collection;
 * nobody scrolls past this many name matches, and the alternative — a keyset over
 * a COMPUTED rank — would have to encode the rank in the cursor and re-derive it
 * identically on every page.
 */
export const MAX_CHANNEL_SEARCH_OFFSET = 500;

/**
 * Longest term worth matching: the longest field it is matched against. Escaping
 * already leaves a literal pattern (no alternation, no quantifiers, so nothing to
 * backtrack), but a term longer than every field it could match is work that can
 * only ever return nothing.
 */
const MAX_CHANNEL_SEARCH_TERM_LENGTH = MAX_CHANNEL_DESCRIPTION_LENGTH;

/**
 * Relevance tiers, ascending — a `$sort` reads them as an ordinary number, so
 * "better" is SMALLER.
 *
 * The one ordering the product actually promises is that somebody who typed a
 * channel's exact handle gets that channel first: a handle is unique and
 * unambiguous, so an exact hit is an answer rather than a candidate, and losing
 * it to a more-followed channel that merely mentions the word in its description
 * is the failure this ranking exists to prevent. Below that, a name match beats a
 * blurb match, and `followerCount` breaks ties.
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
  excludeChannelIds?: mongoose.Types.ObjectId[];
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

  const pattern = escapeRegex(term);
  // `handleLower` is stored canonical-lowercase, so the exact tier compares
  // against the lowercased term — only a stored handle can ever match it.
  const exactHandle = term.toLowerCase();

  const pipeline: PipelineStage[] = [
    {
      $match: {
        visibility: 'public',
        ...(excludeChannelIds && excludeChannelIds.length > 0
          ? { _id: { $nin: excludeChannelIds } }
          : {}),
        // A disjunction is what "matches any of three fields" IS. No
        // `ChronoCursor` is anywhere near this query — the rule that forbids an
        // `$or` applies to the feed match objects `ChronoCursor.applyToQuery`
        // ASSIGNS into, and is stated here so nobody carries it over by reflex.
        $or: [
          { handleLower: { $regex: pattern, $options: 'i' } },
          { title: { $regex: pattern, $options: 'i' } },
          { description: { $regex: pattern, $options: 'i' } },
        ],
      },
    },
    {
      $addFields: {
        searchRank: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$handleLower', exactHandle] },
                then: CHANNEL_SEARCH_RANK.exactHandle,
              },
              {
                case: { $regexMatch: { input: '$handleLower', regex: pattern, options: 'i' } },
                then: CHANNEL_SEARCH_RANK.handle,
              },
              {
                // `$regexMatch` refuses a null input, and a legacy row is not a
                // reason to fail the whole page.
                case: {
                  $regexMatch: {
                    input: { $ifNull: ['$title', ''] },
                    regex: pattern,
                    options: 'i',
                  },
                },
                then: CHANNEL_SEARCH_RANK.title,
              },
            ],
            // Reached only by a row the `$match` already accepted, so the
            // remaining explanation is the description.
            default: CHANNEL_SEARCH_RANK.description,
          },
        },
      },
    },
    { $sort: { searchRank: 1, followerCount: -1, _id: -1 } },
    { $skip: offset },
    // One extra row answers `hasMore` without a second count over the same match.
    { $limit: limit + 1 },
  ];

  const matched = await Channel.aggregate<ChannelLean>(pipeline)
    .option({ maxTimeMS: config.search.maxTimeMS })
    .exec();

  const hasMore = matched.length > limit;
  const page = hasMore ? matched.slice(0, limit) : matched;

  return { items: page.map((channel) => serializeChannel(channel)), hasMore };
}
