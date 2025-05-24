import express from 'express';
import pollsController from '../controllers/polls.controller';

const router = express.Router();

// Create a new poll
router.post('/', pollsController.createPoll);

// Get poll by ID
router.get('/:id', pollsController.getPoll);

// Vote in a poll
router.post('/:id/vote', pollsController.vote);

// Get poll results
router.get('/:id/results', pollsController.getResults);

// Delete a poll
router.delete('/:id', pollsController.deletePoll);

// Update a poll's post ID
router.post('/:id/update-post', pollsController.updatePollPostId);

export default router; 