import express, { Response } from "express";
import mongoose from "mongoose";
import Post from "../models/Post";
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { config } from '../config';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { queryInt } from '../utils/queryParams';
import { PostVisibility } from '@mention/shared-types';
import { decodeSearchCursor, encodeSearchCursor } from '../utils/searchCursor';
import { scanTextEntities } from '@mention/shared-types/textEntities';
import { isAbsoluteHttpUrl } from '../connectors/shared/url';
import { DISCOVERY_SAFE_MATCH } from '../mtn/feed/feedSafety';
import { loadMuteWords, loadShowSensitiveContent } from '../services/safety/viewerSafety';
import {
  NO_FOLLOWED_AUTHORS,
  compileMuteWords,
  isMutedSubject,
} from '../services/safety/muteWordMatcher';
import { loadFollowedAuthorIds } from '../services/viewerFollowGraph';

const router = express.Router();

/** Search result page size. */
const DEFAULT_SEARCH_LIMIT = 20;
/**
 * Is this query nothing but a handle — `@alice`, `@alice@x.com`?
 *
 * Decided with the SHARED entity scanner rather than a regex written here, so
 * "what is a handle" has one definition across the composer, the renderer, the
 * bio qualifier and this route. The test is structural: exactly one entity, of a
 * handle kind, spanning the entire trimmed query.
 */
function isHandleOnlyQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed.startsWith('@')) return false;
  const [entity, ...rest] = scanTextEntities(trimmed);
  return rest.length === 0
    && entity !== undefined
    && (entity.kind === 'federatedHandle' || entity.kind === 'bareHandle')
    && entity.start === 0
    && entity.end === trimmed.length;
}

/** Mongo's MaxTimeMSExpired — a query that hit `maxTimeMS`, not a server fault. */
const MONGO_MAX_TIME_MS_EXPIRED = 50;

const MAX_SEARCH_LIMIT = 100;
// One of the four projections that feed `PostHydrationService`; they must agree
// on every field hydration reads. `writtenByOxyUserId` is what lets a channel
// post name its writer here too — see `mtn/feed/FeedAPI.ts` `FEED_FIELDS`.
const SEARCH_HYDRATION_PROJECTION = [
  '_id',
  'oxyUserId',
  'writtenByOxyUserId',
  'authorship',
  'content',
  'metadata',
  'federation',
  'postClassification.languages',
  'stats',
  'boostOf',
  'quoteOf',
  'laneId',
  'originalPostId',
  'parentPostId',
  'threadId',
  'replyPermission',
  'reviewReplies',
  'quotesDisabled',
  'hashtags',
  'mentions',
  'tags',
  'visibility',
  'status',
  'language',
  'createdAt',
  'updatedAt',
  'date',
].join(' ');

/**
 * Parse search operators from query string.
 * Supported operators:
 *   from:username    - filter posts by author username (`from:me` = the viewer)
 *   to:username      - filter posts mentioning a user (`to:me` = the viewer)
 *   since:YYYY-MM-DD - posts after date
 *   until:YYYY-MM-DD - posts before date
 *   has:media        - posts with media attachments
 *   has:links        - posts with links
 *   min_likes:N      - minimum likes count
 *   min_boosts:N     - minimum boosts count
 *
 * Returns the remaining text query and the extracted operators. This function is
 * PURE and viewer-less: the `me` alias is a property of the request, so it is
 * resolved at the use site (see {@link resolveOperatorUserId}), not here.
 */
interface ParsedOperators {
  textQuery: string;
  from?: string;
  to?: string;
  since?: string;
  until?: string;
  hasMedia?: boolean;
  hasLinks?: boolean;
  minLikes?: number;
  minBoosts?: number;
}

function parseSearchOperators(raw: string): ParsedOperators {
  const result: ParsedOperators = { textQuery: '' };

  // Match operator:value patterns (value can be quoted or unquoted)
  const operatorRegex = /\b(from|to|since|until|has|min_likes|min_boosts):("[^"]*"|[^\s]+)/gi;
  let remaining = raw;

  let match: RegExpExecArray | null;
  while ((match = operatorRegex.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    // Strip surrounding quotes if present
    const value = match[2].replace(/^"|"$/g, '');

    switch (key) {
      case 'from':
        result.from = value.replace(/^@/, ''); // strip leading @
        break;
      case 'to':
        result.to = value.replace(/^@/, ''); // strip leading @
        break;
      case 'since':
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          result.since = value;
        }
        break;
      case 'until':
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          result.until = value;
        }
        break;
      case 'has':
        if (value === 'media') result.hasMedia = true;
        if (value === 'links') result.hasLinks = true;
        break;
      case 'min_likes': {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 0) result.minLikes = n;
        break;
      }
      case 'min_boosts': {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 0) result.minBoosts = n;
        break;
      }
    }

    // Remove the matched operator from the remaining text
    remaining = remaining.replace(match[0], '');
  }

  result.textQuery = remaining.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * Resolve a `from:` / `to:` operand to an Oxy user id, or `undefined` when it
 * names nobody this request can search for.
 *
 * `me` means the viewer. The alias is genuinely ambiguous — a real Oxy account
 * could be named `me` — and it is resolved in favour of the VIEWER, the same
 * call Twitter and Bluesky make: an account literally named `me` is still
 * reachable by any other search, while "my own posts" has no other spelling.
 * Resolving it locally also skips the Oxy round trip entirely.
 *
 * An anonymous viewer has no `me`, so the operator resolves to nobody — the same
 * terminal state as an unknown username, which the caller turns into an empty
 * result set rather than silently dropping the filter (a dropped filter would
 * answer a DIFFERENT question than the one asked).
 */
async function resolveOperatorUserId(
  operand: string,
  currentUserId: string | undefined,
): Promise<string | undefined> {
  if (operand.toLowerCase() === 'me') return currentUserId;
  try {
    const profile = await getRuntimeOxyClient().getProfileByUsername(operand);
    return profile?.id ? String(profile.id) : undefined;
  } catch {
    return undefined;
  }
}

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const {
      query,
      type = "all",
      dateFrom,
      dateTo,
      minLikes,
      minBoosts,
      mediaType,
      hasMedia,
      language,
      cursor
    } = req.query;

    const currentUserId = req.user?.id;
    const results: { posts: unknown[]; hasMore?: boolean; nextCursor?: string } = { posts: [] };

    if (type === "all" || type === "posts") {
      // The viewer's safety rules. Search is a DISCOVERY surface, so it is subject to
      // the same two per-user gates every feed applies — the sensitive/NSFW opt-in and
      // the viewer's muted words. Both loaders short-circuit for an anonymous viewer
      // (no opt-in, no mutes) and soft-fail to their safe default.
      const [showSensitiveContent, muteWords] = await Promise.all([
        loadShowSensitiveContent(currentUserId),
        loadMuteWords(currentUserId),
      ]);
      const compiledMuteWords = compileMuteWords(muteWords);

      // Parse search operators from query string
      const rawQuery = (typeof query === 'string') ? query.trim() : '';
      const operators = parseSearchOperators(rawQuery);

      // Build query with filters
      const filter: Record<string, unknown> = {
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        // Sensitive/NSFW exclusion happens in the QUERY (not post-hoc) so a safe-mode
        // viewer's page is filled with results they can actually see. Same clause the
        // ranked/discovery feeds use — `mtn/feed/feedSafety` is the one definition of
        // "sensitive", never re-implemented here.
        ...(showSensitiveContent ? {} : DISCOVERY_SAFE_MATCH),
      };

      // A PASTED URL IS NOT A TEXT QUERY, AND FEEDING IT TO $text IS BOTH WRONG
      // AND EXPENSIVE.
      //
      // Mongo's text index TOKENISES, and a multi-term $text search is an OR. So
      // `https://x.com/thinkymachines` becomes roughly `https OR x.com OR
      // thinkymachines` — and `https` alone appears in a large share of every
      // post ever written. Two consequences, and the quiet one is worse:
      //
      //   - it times out. Sorting by createdAt (not by text score) means Mongo
      //     must collect EVERY match before it can order them, so the query blew
      //     through config.search.maxTimeMS and surfaced as a 500. Observed in
      //     production at 3017/3036/3119/3078 ms against a 3_000 ms cap.
      //   - when it does NOT time out, the results are noise: posts that merely
      //     contain the word "https", ranked as if they matched what was pasted.
      //
      // Somebody pasting a profile URL is naming an ACCOUNT; the people lane
      // answers that (see `federatedUsernameFromUpstreamUrl` and the bridge
      // resolution lane). The posts lane has nothing to say about it, so it says
      // so immediately instead of scanning the collection to say it slowly.
      //
      // A HANDLE TYPED ALONE is the same shape of mistake and had the same
      // outcome: `@betomoedano@x.com` tokenises to roughly `betomoedano OR x OR
      // com`, and `com` matches most of the collection, so the query spent its
      // whole budget and returned 503. It also names an account rather than
      // describing text, and the people lane is what answers it.
      //
      // ALONE is the condition, and it is doing real work: `@alice what did you
      // think` is a sentence about somebody and stays an ordinary text search.
      // Only a query that is nothing but a handle short-circuits, and posts
      // MENTIONING an account already have their own operator, `to:`.
      if (isAbsoluteHttpUrl(operators.textQuery) || isHandleOnlyQuery(operators.textQuery)) {
        res.json({ posts: [], hasMore: false });
        return;
      }
      // Use the Post text index instead of scanning every variant with a regex.
      if (operators.textQuery) {
        filter.$text = { $search: operators.textQuery };
      }

      // --- Operator-based filters ---

      // from:username — posts AUTHORED by that user (`from:me` = the viewer).
      if (operators.from) {
        const authorId = await resolveOperatorUserId(operators.from, currentUserId);
        if (!authorId) {
          // Nobody to search for (unknown username, or `me` with no session).
          res.json({ posts: [], hasMore: false });
          return;
        }
        filter.authorship = {
          $elemMatch: {
            oxyUserId: authorId,
            status: 'accepted',
          },
        };
      }

      // to:username — posts MENTIONING that user (`to:me` = the viewer).
      // `mentions` holds oxyUserIds and is indexed twice (plain, plus the
      // compound `{mentions, createdAt}` that also serves this query's sort), so
      // containment is an index lookup rather than a scan. Mongo matches an array
      // field by element equality, so the scalar matches any post mentioning them.
      if (operators.to) {
        const mentionedId = await resolveOperatorUserId(operators.to, currentUserId);
        if (!mentionedId) {
          res.json({ posts: [], hasMore: false });
          return;
        }
        filter.mentions = mentionedId;
      }

      // since: / until: operators
      const effectiveDateFrom = operators.since || (typeof dateFrom === 'string' ? dateFrom : undefined);
      const effectiveDateTo = operators.until || (typeof dateTo === 'string' ? dateTo : undefined);

      if (effectiveDateFrom || effectiveDateTo) {
        const createdAtFilter: { $gte?: Date; $lte?: Date } = {};
        let fromDate: Date | undefined;
        let toDate: Date | undefined;

        if (effectiveDateFrom) {
          fromDate = new Date(effectiveDateFrom);
          if (isNaN(fromDate.getTime())) {
            return res.status(400).json({ message: 'Invalid dateFrom format' });
          }
          createdAtFilter.$gte = fromDate;
        }
        if (effectiveDateTo) {
          toDate = new Date(effectiveDateTo);
          if (isNaN(toDate.getTime())) {
            return res.status(400).json({ message: 'Invalid dateTo format' });
          }
          createdAtFilter.$lte = toDate;
        }

        // Validate date range span
        if (fromDate && toDate) {
          const maxRangeMs = config.search.maxDateRangeDays * 24 * 60 * 60 * 1000;
          if (toDate.getTime() - fromDate.getTime() > maxRangeMs) {
            return res.status(400).json({
              message: `Date range cannot exceed ${config.search.maxDateRangeDays} days`
            });
          }
          if (toDate < fromDate) {
            return res.status(400).json({ message: 'dateTo must be after dateFrom' });
          }
        }

        // Only attach the date filter when at least one valid bound was parsed.
        if (Object.keys(createdAtFilter).length > 0) {
          filter.createdAt = createdAtFilter;
        }
      }

      // Engagement filters - operators take precedence over query params
      const effectiveMinLikes = operators.minLikes ?? (typeof minLikes === 'string' ? parseInt(minLikes, 10) : undefined);
      if (effectiveMinLikes !== undefined && !isNaN(effectiveMinLikes) && effectiveMinLikes >= 0) {
        filter['stats.likesCount'] = { $gte: effectiveMinLikes };
      }

      const effectiveMinBoosts = operators.minBoosts ?? (typeof minBoosts === 'string' ? parseInt(minBoosts, 10) : undefined);
      if (effectiveMinBoosts !== undefined && !isNaN(effectiveMinBoosts) && effectiveMinBoosts >= 0) {
        filter['stats.boostsCount'] = { $gte: effectiveMinBoosts };
      }

      // Media filters - operators take precedence
      if (operators.hasMedia || hasMedia === 'true') {
        filter['content.media.0'] = { $exists: true };
      }

      // has:links operator - match URLs in post text
      if (operators.hasLinks) {
        filter.hasLinks = true;
      }

      if (mediaType && typeof mediaType === 'string') {
        const validMediaTypes = ['image', 'video', 'gif'];
        if (validMediaTypes.includes(mediaType)) {
          filter['content.media.type'] = mediaType;
        }
      }

      // Language filter — match the canonical multi-language array (multikey
      // index). Mongo matches an array field by element equality, so the scalar
      // matches any post whose `postClassification.languages` contains it.
      if (language && typeof language === 'string') {
        filter['postClassification.languages'] = language;
      }

      // Cursor-based pagination
      if (cursor !== undefined) {
        const decodedCursor = typeof cursor === 'string'
          ? decodeSearchCursor(cursor)
          : undefined;
        if (!decodedCursor) {
          return res.status(400).json({ message: 'Invalid search cursor' });
        }

        const cursorClause = {
          $or: [
            { createdAt: { $lt: decodedCursor.createdAt } },
            {
              createdAt: decodedCursor.createdAt,
              _id: { $lt: new mongoose.Types.ObjectId(decodedCursor.id) },
            },
          ],
        };
        const andClauses = Array.isArray(filter.$and) ? filter.$and : [];
        filter.$and = [...andClauses, cursorClause];
      }

      // Validate and normalize limit (max 100)
      const limitNum = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

      // Execute query with lean() for read-only performance
      const posts = await Post.find(filter)
        .select(SEARCH_HYDRATION_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limitNum + 1) // Fetch one extra to check if there are more
        .maxTimeMS(config.search.maxTimeMS)
        .lean();

      // Check if there are more results
      const hasMoreResults = posts.length > limitNum;
      const postsToReturn = hasMoreResults ? posts.slice(0, limitNum) : posts;

      // Calculate next cursor
      const nextCursor = hasMoreResults && postsToReturn.length > 0
        ? encodeSearchCursor(
          postsToReturn[postsToReturn.length - 1].createdAt,
          postsToReturn[postsToReturn.length - 1]._id.toString(),
        )
        : undefined;

      // Hydrate posts with viewer-scoped state and embedded quoted/boost
      // originals. Pass the request's oxyClient so viewer-scoped fields
      // (privacy, interactions, viewerState) resolve, and maxDepth:1 so quoted
      // posts and boost originals are embedded (a maxDepth:0 boost renders
      // blank). Mirrors the profile/posts.controller hydration path.
      const scopedOxyClient = createScopedOxyClient(req);
      const transformedPosts = await postHydrationService.hydratePosts(postsToReturn, {
        viewerId: currentUserId,
        oxyClient: scopedOxyClient,
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      // Muted words are matched on the HYDRATED post — the rendition and canonical
      // hashtags the viewer would actually be shown — which is exactly what the feed
      // tuner matches, so a muted word means the same thing on both surfaces. Dropping
      // here (after the cursor was taken from the unfiltered page window above) keeps
      // pagination stable: a page may return fewer than `limit` posts, but no post is
      // skipped on the next page.
      const followedAuthorIds = compiledMuteWords?.needsFollowState
        ? await loadFollowedAuthorIds(currentUserId, scopedOxyClient)
        : NO_FOLLOWED_AUTHORS;
      results.posts = transformedPosts.filter((post) => !isMutedSubject(
        compiledMuteWords,
        { text: post.content?.text, hashtags: post.metadata?.hashtags, authorId: post.user?.id },
        followedAuthorIds,
      ));
      results.hasMore = hasMoreResults;
      results.nextCursor = nextCursor;
    }

    res.json(results);
  } catch (error) {
    // A query that ran out of time is a CAPACITY answer, not a fault. It was
    // reaching the client as a 500, which reads as "the server is broken" and
    // hides the real one behind the same status as a genuine crash. 503 says
    // what happened and is retryable.
    //
    // The log previously carried `errorName` ALONE — so the production incident
    // this branch was diagnosed from showed `MongoServerError` and nothing else:
    // no code, no message, nothing that named the query or the limit. Diagnosing
    // it needed the source and a stopwatch against the 3_000 ms cap. Carry the
    // code and message so the next one is readable from the logs.
    const isTimeout = typeof error === 'object' && error !== null
      && (error as { code?: unknown }).code === MONGO_MAX_TIME_MS_EXPIRED;
    logger.error('Search request failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorCode: typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined,
      reason: error instanceof Error ? error.message : 'unknown',
      timedOut: isTimeout,
    });
    res.status(isTimeout ? 503 : 500).json({
      message: isTimeout ? 'Search timed out' : 'Error performing search',
    });
  }
});

export default router;
