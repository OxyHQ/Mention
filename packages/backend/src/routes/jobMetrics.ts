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
