import { Router } from 'express';
import { requireAdmin } from '../../middleware/admin';
import broadcastsRoutes from './broadcasts.routes';

const router = Router();

// All admin routes require admin privileges
router.use(requireAdmin);

// Sub-route modules
router.use('/broadcasts', broadcastsRoutes);

export default router;
