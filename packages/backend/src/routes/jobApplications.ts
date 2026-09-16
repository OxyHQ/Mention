/**
 * Job APPLICATION routes (OxyHQ/Mention#952 Phase E). Mounted under
 * `authenticatedApi` at `/jobs` — every route here requires login. Sibling to
 * `routes/jobsManagement.ts` (job lifecycle) and `routes/jobs.ts` (public job
 * reads).
 *
 * `/external/:clarityJobId/report` is registered FIRST and uses a literal
 * `external` first segment specifically so it can never be shadowed by the
 * `/:id/applications...` routes below — same discipline `routes/jobs.ts` uses
 * for its own parameterized catch-all.
 */

import express from 'express';
import jobApplicationsController from '../controllers/jobApplications.controller';
import { jobApplicationsRateLimiter } from '../middleware/security';
import { config } from '../config';

const router = express.Router();

/**
 * Production-gated in the PER-ROUTE position, mirroring
 * `channelWriters.routes.ts`: `router.use(...limiters)` with an empty array
 * throws `argument handler is required` at import outside production, and
 * this is also the only position CodeQL's `js/missing-rate-limiting` query
 * inspects.
 */
const limiter = config.runtime.isProduction ? [jobApplicationsRateLimiter] : [];

router.post('/external/:clarityJobId/report', ...limiter, jobApplicationsController.reportExternal);

router.post('/:id/applications', ...limiter, jobApplicationsController.submit);
router.get('/:id/applications', ...limiter, jobApplicationsController.listForEmployer);
router.put('/:id/applications/:applicationId', ...limiter, jobApplicationsController.updateStatus);
router.post('/:id/applications/:applicationId/notes', ...limiter, jobApplicationsController.addNote);
router.get('/:id/applications/:applicationId/notes', ...limiter, jobApplicationsController.listNotes);
router.post('/:id/applications/:applicationId/withdraw', ...limiter, jobApplicationsController.withdraw);

export default router;
