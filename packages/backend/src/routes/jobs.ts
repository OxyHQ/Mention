import express from 'express';
import jobsController from '../controllers/jobs.controller';

const router = express.Router();

// Genuinely public: Clarity-backed global discovery.
router.get('/', jobsController.search);

// Private single-segment read: self-guarded (401 when unauthenticated), here
// only so the public `/:id` below cannot shadow `/jobs/mine` — same discipline
// `publicPostsRouter` uses for `/posts/drafts`.
router.get('/mine', jobsController.getMine);

// Public, but self-elevated for an authorized operator — see the controller.
router.get('/organization/:employerOxyUserId', jobsController.getOrganizationJobs);

// Public canonical job page — parameterized, MUST be registered LAST so every
// literal read above resolves first.
router.get('/:id', jobsController.getJob);

export default router;
