import express, { Request, Response } from "express";
import mongoose from "mongoose";
import Post from "../models/Post";
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { config } from '../config';
import { oxy as oxyClient } from '../../server';
import { queryInt } from '../utils/queryParams';

const router = express.Router();

/** Search result page size. */
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

// Helper to escape regex special characters (prevent ReDoS)
const escapeRegex = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Parse search operators from query string.
 * Supported operators:
 *   from:username    - filter posts by author username
 *   since:YYYY-MM-DD - posts after date
 *   until:YYYY-MM-DD - posts before date
 *   has:media        - posts with media attachments
 *   has:links        - posts with links
 *   min_likes:N      - minimum likes count
 *   min_boosts:N     - minimum boosts count
 *
 * Returns the remaining text query and the extracted operators.
 */
interface ParsedOperators {
  textQuery: string;
  from?: string;
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
  const operatorRegex = /\b(from|since|until|has|min_likes|min_boosts):("[^"]*"|[^\s]+)/gi;
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
      // Parse search operators from query string
      const rawQuery = (typeof query === 'string') ? query.trim() : '';
      const operators = parseSearchOperators(rawQuery);

      // Build query with filters
      const filter: Record<string, unknown> = {};

      // Text search with escaped regex (prevent ReDoS)
      if (operators.textQuery) {
        const escapedQuery = escapeRegex(operators.textQuery);
        filter.$or = [
          { 'content.text': { $regex: escapedQuery, $options: 'i' } },
          { hashtags: { $regex: escapedQuery, $options: 'i' } }
        ];
      }

      // --- Operator-based filters ---

      // from:username - resolve username to oxyUserId
      if (operators.from) {
        try {
          const profile = await oxyClient.getProfileByUsername(operators.from);
          const profileId = profile?.id;
          if (profileId) {
            filter.oxyUserId = String(profileId);
          } else {
            // Username not found - return empty results
            res.json({ posts: [], hasMore: false });
            return;
          }
        } catch {
          // Username not found - return empty results
          res.json({ posts: [], hasMore: false });
          return;
        }
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
        const linkCondition = { 'content.text': { $regex: 'https?://', $options: 'i' } };
        if (filter.$or) {
          // Combine with existing text search using $and
          const andClauses = Array.isArray(filter.$and) ? filter.$and : [];
          andClauses.push(linkCondition);
          filter.$and = andClauses;
        } else {
          filter['content.text'] = { $regex: 'https?://', $options: 'i' };
        }
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
      if (cursor && typeof cursor === 'string' && mongoose.Types.ObjectId.isValid(cursor)) {
        filter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      // Validate and normalize limit (max 100)
      const limitNum = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

      // Execute query with lean() for read-only performance
      const posts = await Post.find(filter)
        .sort({ createdAt: -1 })
        .limit(limitNum + 1) // Fetch one extra to check if there are more
        .lean();

      // Check if there are more results
      const hasMoreResults = posts.length > limitNum;
      const postsToReturn = hasMoreResults ? posts.slice(0, limitNum) : posts;

      // Calculate next cursor
      const nextCursor = hasMoreResults && postsToReturn.length > 0
        ? postsToReturn[postsToReturn.length - 1]._id.toString()
        : undefined;

      // Hydrate posts with viewer-scoped state and embedded quoted/boost
      // originals. Pass the request's oxyClient so viewer-scoped fields
      // (privacy, interactions, viewerState) resolve, and maxDepth:1 so quoted
      // posts and boost originals are embedded (a maxDepth:0 boost renders
      // blank). Mirrors the profile/posts.controller hydration path.
      const transformedPosts = await postHydrationService.hydratePosts(postsToReturn, {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      results.posts = transformedPosts;
      results.hasMore = hasMoreResults;
      results.nextCursor = nextCursor;
    }

    res.json(results);
  } catch (error) {
    logger.error('Search error:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({
      message: "Error performing search",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

export default router;