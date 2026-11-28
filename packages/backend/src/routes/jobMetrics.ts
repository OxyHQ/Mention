// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Job METRICS routes (OxyHQ/Mention#952 Phase E). Mounted under `publicApi`
 * with `optionalAuth` at `/jobs` — `POST /jobs/:id/metrics` must work
 * unauthenticated (an anonymous view still counts); `GET /jobs/:id/metrics`
 * self-guards through `assertCanManageJob` in the controller. See
 * `controllers/jobMetrics.controller.ts`.
 */

import express from 'express';
import jobMetricsController from '../controllers/jobMetrics.controller';

const router = express.Router();

router.post('/:id/metrics', jobMetricsController.record);
router.get('/:id/metrics', jobMetricsController.summary);

export default router;
