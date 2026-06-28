import { Router, Response } from 'express';
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { createSyraClient } from '@syra.fm/sdk';
import { config } from '../config';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Profile Song picker API.
 * Owner-only proxy in front of the public Syra catalog (avoids browser CORS and
 * keeps the catalog base URL server-owned). Only an authenticated user picking
 * their own song reaches these routes.
 */
router.use(requireAuth);

// Headless Syra catalog client (public reads only; Bun/Node provide global fetch).
const syraClient = createSyraClient({ baseURL: config.syra.apiUrl });

// Cap returned rows so a song picker stays snappy. The SDK already filters to
// preview-eligible tracks, so every result is playable as a profile song.
const SEARCH_RESULT_LIMIT = 20;

/**
 * GET /api/profile/song/search?q=
 * Search the Syra public catalog for preview-eligible tracks.
 */
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const rawQuery = req.query.q;
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (!query) {
      return sendErrorResponse(res, 400, 'Bad Request', 'Missing q parameter');
    }

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
        // saving. Built at start 0 — the saved start offset is resolved + clamped
        // server-side on PUT /profile/settings.
        previewUrl: previewAvailable ? syraClient.previewUrl(track.id, 0) : undefined,
      };
    });

    return sendSuccessResponse(res, 200, results);
  } catch (err) {
    logger.error('[ProfileSong] Error searching Syra catalog:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to search songs');
  }
});

export default router;
