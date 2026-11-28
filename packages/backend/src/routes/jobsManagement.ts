// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import express from 'express';
import jobsManagementController from '../controllers/jobsManagement.controller';
import jobPlacesController from '../controllers/jobPlaces.controller';
import { jobPlacesSearchRateLimiter, jobsManagementRateLimiter } from '../middleware/security';
import { config } from '../config';

const router = express.Router();

/**
 * Production-gated in the PER-ROUTE position, mirroring
 * `channelWriters.routes.ts`: `router.use(...limiters)` with an empty array
 * throws `argument handler is required` at import outside production, and
 * this is also the only position CodeQL's `js/missing-rate-limiting` query
 * inspects.
 */
const limiter = config.runtime.isProduction ? [jobsManagementRateLimiter] : [];
const placesLimiter = config.runtime.isProduction ? [jobPlacesSearchRateLimiter] : [];

// Two segments, so the public `GET /jobs/:id` (mounted first, on the public
// router) can never shadow it; it lands here, behind `requireAuth`.
router.get('/places/search', ...placesLimiter, jobPlacesController.search);

router.post('/', ...limiter, jobsManagementController.create);
router.put('/:id', ...limiter, jobsManagementController.update);
router.post('/:id/publish', ...limiter, jobsManagementController.publish);
router.post('/:id/pause', ...limiter, jobsManagementController.pause);
router.post('/:id/close', ...limiter, jobsManagementController.close);
router.post('/:id/duplicate', ...limiter, jobsManagementController.duplicate);

export default router;
