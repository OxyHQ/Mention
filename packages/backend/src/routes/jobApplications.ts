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

const router = express.Router();

router.post('/external/:clarityJobId/report', jobApplicationsController.reportExternal);

router.post('/:id/applications', jobApplicationsController.submit);
router.get('/:id/applications', jobApplicationsController.listForEmployer);
router.put('/:id/applications/:applicationId', jobApplicationsController.updateStatus);
router.post('/:id/applications/:applicationId/notes', jobApplicationsController.addNote);
router.get('/:id/applications/:applicationId/notes', jobApplicationsController.listNotes);
router.post('/:id/applications/:applicationId/withdraw', jobApplicationsController.withdraw);

export default router;
