// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import express from 'express';
import { validateObjectId } from '../middleware/validate';
import pollsController from '../controllers/polls.controller';

const router = express.Router();

// Public routes
// Get poll by ID (public for viewing)
router.get('/:id', validateObjectId('id'), pollsController.getPoll);
// Get poll results (public for viewing results)
router.get('/:id/results', validateObjectId('id'), pollsController.getResults);

// Protected routes
// Create a new poll
router.post('/', pollsController.createPoll);
// Vote in a poll
router.post('/:id/vote', validateObjectId('id'), pollsController.vote);
// Delete a poll
router.delete('/:id', validateObjectId('id'), pollsController.deletePoll);
// Update a poll's post ID
router.post('/:id/update-post', validateObjectId('id'), pollsController.updatePollPostId);

export default router;
