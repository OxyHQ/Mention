/**
 * `GET /jobs/places/search` — the job form's location autocomplete.
 *
 * A thin, authenticated proxy over `clarity.places.search`: the frontend cannot
 * hold Mention's Clarity service credential, and a job's place id must come
 * from the same gazetteer the job write resolves it against
 * (`services/jobPlaces.ts`). Mounted under `authenticatedApi`, so `req.user` is
 * always present here.
 */

import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { isCountryCode, type CountryCode, type MentionJobPlaceSearchResponse } from '@mention/shared-types';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';
import {
  JOB_PLACE_SEARCH_DEFAULT_LIMIT,
  JOB_PLACE_SEARCH_MAX_LIMIT,
  JobPlacesUnavailableError,
  searchJobPlaces,
} from '../services/jobPlaces';

export const placeSearchQuerySchema = z.object({
  q: z
    .string('q is required')
    .trim()
    .min(1, 'q is required')
    .max(100, 'q must be at most 100 characters'),
  countryCode: z
    .custom<CountryCode>(isCountryCode, 'countryCode must be an ISO 3166-1 alpha-2 country code (e.g. "ES")')
    .optional(),
  kind: z.enum(['city', 'region'], 'kind must be city or region').optional(),
  limit: z.coerce
    .number('limit must be a number')
    .int('limit must be a whole number')
    .min(1, 'limit must be at least 1')
    .max(JOB_PLACE_SEARCH_MAX_LIMIT, `limit must be at most ${JOB_PLACE_SEARCH_MAX_LIMIT}`)
    .default(JOB_PLACE_SEARCH_DEFAULT_LIMIT),
});

class JobPlacesController {
  async search(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });

      const parsed = placeSearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.') || '(query)',
          message: issue.message,
        }));
        return res.status(400).json({ error: 'Validation error', message: issues[0]?.message, issues });
      }

      const places = await searchJobPlaces(parsed.data);
      const body: MentionJobPlaceSearchResponse = { places };
      res.json(body);
    } catch (error) {
      if (error instanceof JobPlacesUnavailableError) {
        return res.status(503).json({ error: 'Service unavailable', message: error.message });
      }
      logger.error('[JobPlaces] Error in search:', error);
      next(createError(500, 'Error searching places'));
    }
  }
}

export default new JobPlacesController();
