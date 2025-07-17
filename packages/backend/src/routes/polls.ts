import express from 'express';
import pollsController from '../controllers/polls.controller';

const router = express.Router();

// Public routes
// Get poll by ID (public for viewing)
router.get('/:id', pollsController.getPoll);
// Get poll results (public for viewing results)
router.get('/:id/results', pollsController.getResults);

// Protected routes
// Create a new poll
router.post('/', pollsController.createPoll);
// Vote in a poll
router.post('/:id/vote', pollsController.vote);
// Delete a poll
router.delete('/:id', pollsController.deletePoll);
// Update a poll's post ID
router.post('/:id/update-post', pollsController.updatePollPostId);

export default router; 