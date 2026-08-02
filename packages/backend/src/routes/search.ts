import express, { Response } from "express";
import { and, arrayContains, desc, eq, exists, gte, lte, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postAuthorships, postContentVariants, postMedia, postMentions } from '../db/schema/postContent';
import { findPostRecords } from '../db/posts/postRepository';
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { config } from '../config';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { queryInt } from '../utils/queryParams';
import { PostVisibility } from '@mention/shared-types';
import { decodeChronoCursor, encodeChronoCursor } from '../utils/chronoCursor';
import { discoverySafeSql } from '../mtn/feed/feedSafety';
import { loadMuteWords, loadShowSensitiveContent } from '../services/safety/viewerSafety';
import {
  NO_FOLLOWED_AUTHORS,
  compileMuteWords,
  isMutedSubject,
} from '../services/safety/muteWordMatcher';
import { loadFollowedAuthorIds } from '../services/viewerFollowGraph';

const router = express.Router();

/**
 * "The post has at least one media row", optionally of one type.
 *
 * An EXISTS over `post_media`, which is what Mongo's `content.media.0` /
 * `content.media.type` probes meant against the embedded array.
 */
function mediaExists(type?: 'image' | 'video' | 'gif'): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(postMedia)
      .where(and(
        eq(postMedia.postId, posts.id),
        ...(type ? [eq(postMedia.type, type)] : []),
      )),
  ) as SQL;
}

/** Search result page size. */
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
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
      const conditions: SQL[] = [
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ];
      // Sensitive/NSFW exclusion happens in the QUERY (not post-hoc) so a safe-mode
      // viewer's page is filled with results they can actually see. Same clause the
      // ranked/discovery feeds use — `mtn/feed/feedSafety` is the one definition of
      // "sensitive", never re-implemented here.
      if (!showSensitiveContent) conditions.push(discoverySafeSql());

      // The GIN-indexed `search_vector` on the renditions — the port of the Mongo
      // text index, and there for the same reason: never a regex scan over every
      // variant. `websearch_to_tsquery` is the parser whose input language matches
      // what a user types (quoted phrases, `or`, a leading `-`), and unlike
      // `to_tsquery` it cannot raise a syntax error on arbitrary input.
      if (operators.textQuery) {
        conditions.push(
          exists(
            getDb()
              .select({ one: sql`1` })
              .from(postContentVariants)
              .where(and(
                eq(postContentVariants.postId, posts.id),
                sql`${postContentVariants.searchVector} @@ websearch_to_tsquery('english', ${operators.textQuery})`,
              )),
          ) as SQL,
        );
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
        conditions.push(
          exists(
            getDb()
              .select({ one: sql`1` })
              .from(postAuthorships)
              .where(and(
                eq(postAuthorships.postId, posts.id),
                eq(postAuthorships.oxyUserId, authorId),
                eq(postAuthorships.status, 'accepted'),
              )),
          ) as SQL,
        );
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
        conditions.push(
          exists(
            getDb()
              .select({ one: sql`1` })
              .from(postMentions)
              .where(and(
                eq(postMentions.postId, posts.id),
                eq(postMentions.oxyUserId, mentionedId),
              )),
          ) as SQL,
        );
      }

      // since: / until: operators
      const effectiveDateFrom = operators.since || (typeof dateFrom === 'string' ? dateFrom : undefined);
      const effectiveDateTo = operators.until || (typeof dateTo === 'string' ? dateTo : undefined);

      if (effectiveDateFrom || effectiveDateTo) {
        const dateBounds: SQL[] = [];
        let fromDate: Date | undefined;
        let toDate: Date | undefined;

        if (effectiveDateFrom) {
          fromDate = new Date(effectiveDateFrom);
          if (isNaN(fromDate.getTime())) {
            return res.status(400).json({ message: 'Invalid dateFrom format' });
          }
          dateBounds.push(gte(posts.createdAt, fromDate));
        }
        if (effectiveDateTo) {
          toDate = new Date(effectiveDateTo);
          if (isNaN(toDate.getTime())) {
            return res.status(400).json({ message: 'Invalid dateTo format' });
          }
          dateBounds.push(lte(posts.createdAt, toDate));
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
        conditions.push(...dateBounds);
      }

      // Engagement filters - operators take precedence over query params
      const effectiveMinLikes = operators.minLikes ?? (typeof minLikes === 'string' ? parseInt(minLikes, 10) : undefined);
      if (effectiveMinLikes !== undefined && !isNaN(effectiveMinLikes) && effectiveMinLikes >= 0) {
        conditions.push(gte(posts.statsLikesCount, effectiveMinLikes));
      }

      const effectiveMinBoosts = operators.minBoosts ?? (typeof minBoosts === 'string' ? parseInt(minBoosts, 10) : undefined);
      if (effectiveMinBoosts !== undefined && !isNaN(effectiveMinBoosts) && effectiveMinBoosts >= 0) {
        conditions.push(gte(posts.statsBoostsCount, effectiveMinBoosts));
      }

      // Media filters - operators take precedence
      if (operators.hasMedia || hasMedia === 'true') {
        conditions.push(mediaExists());
      }

      // has:links operator - match URLs in post text
      if (operators.hasLinks) {
        conditions.push(eq(posts.hasLinks, true));
      }

      if (mediaType === 'image' || mediaType === 'video' || mediaType === 'gif') {
        conditions.push(mediaExists(mediaType));
      }

      // Language filter — match the canonical multi-language array (multikey
      // index). Mongo matches an array field by element equality, so the scalar
      // matches any post whose `postClassification.languages` contains it.
      if (language && typeof language === 'string') {
        conditions.push(arrayContains(posts.classificationLanguages, [language]));
      }

      // Cursor-based pagination
      if (cursor !== undefined) {
        const decodedCursor = typeof cursor === 'string'
          ? decodeChronoCursor(cursor)
          : undefined;
        if (!decodedCursor) {
          return res.status(400).json({ message: 'Invalid search cursor' });
        }

        // The keyset matches the `(created_at DESC, id DESC)` sort below exactly.
        // The id bound is a plain `text` comparison and no longer has to parse as
        // an ObjectId — which is what stopped it working the moment ids became
        // uuid v7.
        conditions.push(
          or(
            lt(posts.createdAt, decodedCursor.createdAt),
            and(eq(posts.createdAt, decodedCursor.createdAt), lt(posts.id, decodedCursor.id)),
          ) as SQL,
        );
      }

      // Validate and normalize limit (max 100)
      const limitNum = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

      // Execute query with lean() for read-only performance
      const page = await findPostRecords(and(...conditions), {
        orderBy: [desc(posts.createdAt), desc(posts.id)],
        limit: limitNum + 1, // Fetch one extra to check if there are more
      });

      // Check if there are more results
      const hasMoreResults = page.length > limitNum;
      const postsToReturn = hasMoreResults ? page.slice(0, limitNum) : page;

      // Calculate next cursor
      const anchor = hasMoreResults ? postsToReturn[postsToReturn.length - 1] : undefined;
      const nextCursor = anchor ? encodeChronoCursor(anchor.createdAt, anchor.id) : undefined;

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
    logger.error('Search request failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    res.status(500).json({
      message: "Error performing search"
    });
  }
});

export default router;
