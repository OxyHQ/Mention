import { Router, Response } from 'express';
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { createSyraClient } from '@syra.fm/sdk';
import { config } from '../config';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
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

// Headless Syra catalog client (public reads only; Bun/Node provide global fetch).
const syraClient = createSyraClient({ baseURL: config.syra.apiUrl });

// Cap returned rows so the picker stays snappy. The SDK already filters track
// results to preview-eligible tracks, so every song result is playable.
const SEARCH_RESULT_LIMIT = 20;

/**
 * GET /api/profile/media/search?type=song|podcast&q=
 * Search the Syra public catalog for either preview-eligible tracks or podcast
 * shows, depending on `type`.
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

    if (type === 'song') {
      const tracks = await syraClient.searchTracks(query, { limit: SEARCH_RESULT_LIMIT });

      const results = tracks.map((track) => {
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

      return sendSuccessResponse(res, 200, results);
    }

    const shows = await syraClient.searchPodcasts(query, { limit: SEARCH_RESULT_LIMIT });

    const results = shows.map((show) => ({
      syraPodcastId: show.id,
      title: show.title,
      author: show.author,
      artworkUrl: syraClient.podcastArtworkUrl(show),
    }));

    return sendSuccessResponse(res, 200, results);
  } catch (err) {
    logger.error('[ProfileMedia] Error searching Syra catalog:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to search profile media');
  }
});

export default router;
