import express from 'express';
import jobsManagementController from '../controllers/jobsManagement.controller';

const router = express.Router();

router.post('/', jobsManagementController.create);
router.put('/:id', jobsManagementController.update);
router.post('/:id/publish', jobsManagementController.publish);
router.post('/:id/pause', jobsManagementController.pause);
router.post('/:id/close', jobsManagementController.close);
router.post('/:id/duplicate', jobsManagementController.duplicate);

export default router;
