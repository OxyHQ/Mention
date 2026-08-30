/**
 * The proximity reads: posts near a point, posts inside a bounding box, posts
 * near BOTH the viewer and the post's own location, and the coverage stats.
 *
 * Every filter goes through `withinRadius` so the GiST index on the generated
 * `geography` column is the thing that answers it.
 */

import { Response } from 'express';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '../../db/postgres';
import { posts as postsTable } from '../../db/schema/posts';
import { CHRONO_DESC, findPostRecords } from '../../db/posts/postRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { config } from '../../config';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import { queryString } from '../../utils/queryParams';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';

const DEFAULT_NEARBY_RADIUS_METERS = config.posts.defaultNearbyRadiusMeters;
const MAX_NEARBY_POSTS = config.posts.maxNearbyPosts;
/**
 * The both-location proximity read is allowed a wider page than the
 * single-location one, because a post can qualify through either point and the
 * union is therefore sparser per unit of scan. It was a bare `75` inline.
 */
const MAX_NEARBY_BOTH_LOCATIONS_POSTS = 75;

/**
 * The radius bound, as the index-usable spelling.
 *
 * `ST_DWithin(geo, point, metres)` is what the GiST index on the generated
 * `geography` column answers; `ST_Distance(...) <= metres` computes a distance
 * for every row in the table and cannot use it. `ST_MakePoint` takes LONGITUDE
 * FIRST, which is also the order the generated columns are built in — a
 * transposed pair yields a plausible point in the wrong hemisphere rather than
 * an error, so the order is stated once, here.
 */
function withinRadius(
  geoColumn: AnyPgColumn,
  longitude: number,
  latitude: number,
  radiusMeters: number,
): SQL {
  return sql`ST_DWithin(${geoColumn}, ST_MakePoint(${longitude}, ${latitude})::geography, ${radiusMeters})`;
}
const MAX_AREA_POSTS = config.posts.maxAreaPosts;

// Get nearby posts based on location
export const getNearbyPosts = async (req: AuthRequest, res: Response) => {
  try {
    const lat = queryString(req.query.lat);
    const lng = queryString(req.query.lng);
    const locationType = queryString(req.query.locationType) ?? 'content';

    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const rawRadius = queryString(req.query.radius);
    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);
    const radiusMeters = rawRadius === undefined
      ? DEFAULT_NEARBY_RADIUS_METERS
      : Number.parseInt(rawRadius, 10);

    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    const geoColumn = locationType === 'post' ? postsTable.geo : postsTable.contentGeo;
    const posts = await findPostRecords(
      and(
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
        withinRadius(geoColumn, longitude, latitude, radiusMeters),
      ),
      // Chronological, not nearest-first: `$near` sorts by distance, but the
      // Mongoose call overrode that with its own `createdAt` sort, so the
      // distance ordering was already discarded before this port.
      { orderBy: CHRONO_DESC, limit: MAX_NEARBY_POSTS },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: false,
    });

    res.json({
      posts: hydratedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType,
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching nearby posts', error);
    res.status(500).json({ message: 'Error fetching nearby posts' });
  }
};

// Get posts within a bounding box area
export const getPostsInArea = async (req: AuthRequest, res: Response) => {
  try {
    const north = queryString(req.query.north);
    const south = queryString(req.query.south);
    const east = queryString(req.query.east);
    const west = queryString(req.query.west);
    const locationType = queryString(req.query.locationType) ?? 'content';

    if (!north || !south || !east || !west) {
      return res.status(400).json({
        message: 'Bounding box coordinates (north, south, east, west) are required'
      });
    }

    const northLat = Number.parseFloat(north);
    const southLat = Number.parseFloat(south);
    const eastLng = Number.parseFloat(east);
    const westLng = Number.parseFloat(west);

    if (Number.isNaN(northLat) || Number.isNaN(southLat) || Number.isNaN(eastLng) || Number.isNaN(westLng)) {
      return res.status(400).json({ message: 'Invalid bounding box coordinates' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    const geoColumn = locationType === 'post' ? postsTable.geo : postsTable.contentGeo;
    // `ST_MakeEnvelope(west, south, east, north, 4326)` — the same corner order
    // as Mongo's `$box`, and the same SRID the generated points carry. Cast to
    // `geography` so the comparison is against the column's own type; the `&&`
    // bounding-box operator is what the GiST index answers.
    const envelope = sql`ST_MakeEnvelope(${westLng}, ${southLat}, ${eastLng}, ${northLat}, 4326)::geography`;
    const posts = await findPostRecords(
      and(
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
        sql`${geoColumn} is not null and ${geoColumn} && ${envelope}`,
      ),
      { orderBy: CHRONO_DESC, limit: MAX_AREA_POSTS },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: false,
    });

    res.json({
      posts: hydratedPosts,
      boundingBox: { north: northLat, south: southLat, east: eastLng, west: westLng },
      locationType,
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching posts in area', error);
    res.status(500).json({ message: 'Error fetching posts in area' });
  }
};

// Get nearby posts based on both user and post locations
export const getNearbyPostsBothLocations = async (req: AuthRequest, res: Response) => {
  try {
    const lat = queryString(req.query.lat);
    const lng = queryString(req.query.lng);
    const rawRadius = queryString(req.query.radius);

    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);
    const radiusMeters = rawRadius === undefined
      ? DEFAULT_NEARBY_RADIUS_METERS
      : Number.parseInt(rawRadius, 10);

    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    const posts = await findPostRecords(
      and(
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
        or(
          withinRadius(postsTable.contentGeo, longitude, latitude, radiusMeters),
          withinRadius(postsTable.geo, longitude, latitude, radiusMeters),
        ) as SQL,
      ),
      // Slightly higher limit since we're querying both location types
      { orderBy: CHRONO_DESC, limit: MAX_NEARBY_BOTH_LOCATIONS_POSTS },
    );

    const currentUserId = req.user?.id;
    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType: 'both',
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching nearby posts (both locations)', error);
    res.status(500).json({ message: 'Error fetching nearby posts (both locations)' });
  }
};

// Get location statistics for analytics
export const getLocationStats = async (_req: AuthRequest, res: Response) => {
  try {
    // ONE grouped pass rather than five COUNTs over the same public/published
    // scan: each column is `NOT NULL`-tested inline. The pair CHECKs make
    // longitude and latitude present together, so testing one coordinate answers
    // for the point.
    const publicPublished = and(
      eq(postsTable.visibility, 'public'),
      eq(postsTable.status, 'published'),
    );
    const hasContentLocation = sql`${postsTable.contentLocationLatitude} is not null`;
    const hasPostLocation = sql`${postsTable.locationLatitude} is not null`;
    const [counts] = await getDb()
      .select({
        total: sql<number>`count(*)::int`,
        withContentLocation: sql<number>`count(*) filter (where ${hasContentLocation})::int`,
        withPostLocation: sql<number>`count(*) filter (where ${hasPostLocation})::int`,
        withBothLocations: sql<number>`count(*) filter (where ${hasContentLocation} and ${hasPostLocation})::int`,
        withAnyLocation: sql<number>`count(*) filter (where ${hasContentLocation} or ${hasPostLocation})::int`,
      })
      .from(postsTable)
      .where(publicPublished);

    const totalPosts = counts?.total ?? 0;
    const contentLocationCount = counts?.withContentLocation ?? 0;
    const postLocationCount = counts?.withPostLocation ?? 0;
    const bothLocationsCount = counts?.withBothLocations ?? 0;

    res.json({
      total: totalPosts,
      withContentLocation: contentLocationCount,
      withPostLocation: postLocationCount,
      withBothLocations: bothLocationsCount,
      withAnyLocation: counts?.withAnyLocation ?? 0,
      percentages: {
        contentLocation: totalPosts > 0 ? ((contentLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        postLocation: totalPosts > 0 ? ((postLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        bothLocations: totalPosts > 0 ? ((bothLocationsCount / totalPosts) * 100).toFixed(2) : '0.00'
      }
    });
  } catch (error) {
    logger.error('Error fetching location stats', error);
    res.status(500).json({ message: 'Error fetching location stats' });
  }
};

// ── Translate ──
