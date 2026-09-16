import express from 'express';
import jobsManagementController from '../controllers/jobsManagement.controller';
import { jobsManagementRateLimiter } from '../middleware/security';
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

router.post('/', ...limiter, jobsManagementController.create);
router.put('/:id', ...limiter, jobsManagementController.update);
router.post('/:id/publish', ...limiter, jobsManagementController.publish);
router.post('/:id/pause', ...limiter, jobsManagementController.pause);
router.post('/:id/close', ...limiter, jobsManagementController.close);
router.post('/:id/duplicate', ...limiter, jobsManagementController.duplicate);

export default router;
