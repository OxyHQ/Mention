import { Router, Response } from 'express';
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { syraClient, listPodcastEpisodes } from '../utils/syraPodcast';
import { sendErrorResponse } from '../utils/apiHelpers';
import { sendPaginated } from '../utils/apiResponse';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Profile Media picker API.
 * Owner-only proxy in front of the public Syra catalog (avoids browser CORS and
 * keeps the catalog base URL server-owned). Only an authenticated user picking
 * their own profile media reaches these routes. A profile pins EITHER a song OR
 * a podcast show — this search proxies both catalogs behind one endpoint.
 */
router.use(requireAuth);

// Cap returned rows so the picker stays snappy. The SDK already filters track
// results to preview-eligible tracks, so every song result is playable.
const SEARCH_RESULT_LIMIT = 20;

/**
 * GET /api/profile/media/search?type=song|podcast&q=&offset=
 * Search the Syra public catalog for either preview-eligible tracks or podcast
 * shows, depending on `type`. Paginated for infinite scroll: `offset` advances
 * through the matching set in `SEARCH_RESULT_LIMIT`-sized pages, and the
 * response carries `{ data, pagination }` so the client can request the next
 * page. `hasMore` comes from the Syra backend, not the page's row count (the
 * SDK filters tracks to preview-eligible ones, so a page can be short while
 * more results remain).
 */
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const rawType = req.query.type;
    const type = typeof rawType === 'string' ? rawType.trim() : '';
    if (type !== 'song' && type !== 'podcast') {
      return sendErrorResponse(res, 400, 'Bad Request', 'type must be "song" or "podcast"');
    }

    const rawQuery = req.query.q;
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (!query) {
      return sendErrorResponse(res, 400, 'Bad Request', 'Missing q parameter');
    }

    // Zero-based page offset for infinite scroll. Absent or malformed values
    // start from the first page rather than erroring a scroll.
    const rawOffset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    if (type === 'song') {
      const page = await syraClient.searchTracks(query, { limit: SEARCH_RESULT_LIMIT, offset });

      const results = page.items.map((track) => {
        const previewAvailable = track.previewAvailable === true;
        return {
          syraTrackId: track.id,
          title: track.title,
          artist: track.artistName,
          artworkUrl: syraClient.artworkUrl(track),
          durationSec: track.duration,
          previewAvailable,
          // The Syra preview URL can only be built server-side (Syra base URL +
          // SDK), so surface it here for the picker to audition a track before
          // saving. Built at start 0 — the saved start offset is resolved +
          // clamped server-side on PUT /profile/settings.
          previewUrl: previewAvailable ? syraClient.previewUrl(track.id, 0) : undefined,
        };
      });

      return sendPaginated(res, results, {
        hasMore: page.hasMore,
        offset: page.offset,
        limit: page.limit,
      });
    }

    const page = await syraClient.searchPodcasts(query, { limit: SEARCH_RESULT_LIMIT, offset });

    const results = page.items.map((show) => ({
      syraPodcastId: show.id,
      title: show.title,
      author: show.author,
      artworkUrl: syraClient.podcastArtworkUrl(show),
    }));

    return sendPaginated(res, results, {
      hasMore: page.hasMore,
      offset: page.offset,
      limit: page.limit,
    });
  } catch (err) {
    logger.error('[ProfileMedia] Error searching Syra catalog:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to search profile media');
  }
});

/**
 * GET /api/profile/media/podcasts/:id/episodes?offset=
 * List a Syra podcast show's episodes for the episode picker, proxied server-side
 * for the same reason as `/search` (avoids browser CORS, keeps the Syra base URL
 * server-owned). Paginated for infinite scroll: `offset` advances through the
 * show's episodes in SDK-sized pages, and `hasMore` comes from the Syra backend,
 * not the page's row count (invalid/enclosure-less rows are dropped by the SDK,
 * so a page can be short while more episodes remain). The playable audio URL is
 * intentionally NOT surfaced here — it is resolved server-side only at
 * stream-start (see `POST /rooms/:id/stream/podcast`).
 */
router.get('/podcasts/:id/episodes', async (req: AuthRequest, res: Response) => {
  try {
    const rawId = req.params.id;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) {
      return sendErrorResponse(res, 400, 'Bad Request', 'Missing podcast id');
    }

    // Zero-based page offset for infinite scroll. Absent or malformed values
    // start from the first page rather than erroring a scroll.
    const rawOffset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const page = await listPodcastEpisodes(id, { offset });

    return sendPaginated(res, page.items, {
      hasMore: page.hasMore,
      offset: page.offset,
      limit: page.limit,
    });
  } catch (err) {
    logger.error('[ProfileMedia] Error listing Syra podcast episodes:', {
      userId: req.user?.id,
      podcastId: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list podcast episodes');
  }
});

export default router;
