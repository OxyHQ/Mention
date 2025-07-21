import express from "express";
import { ProfileController } from "../controllers/profiles.controller";

const router = express.Router();
const profileController = new ProfileController();

// Public routes (no authentication required)
router.get('/search', profileController.searchProfiles);
router.get('/:oxyUserId', profileController.getProfileByOxyUserId);

// Protected routes (require authentication) - these will be mounted with auth middleware
const authenticatedRouter = express.Router();

// GET /api/profiles - Get or create current user's profile (auto-creation logic)
authenticatedRouter.get('/', profileController.getOrCreateUserProfile);

// POST /api/profiles - Create new profile for authenticated user  
authenticatedRouter.post('/', profileController.createProfile);

// PUT /api/profiles - Update current user's profile
authenticatedRouter.put('/', profileController.updateUserProfile);

// DELETE /api/profiles - Delete current user's profile
authenticatedRouter.delete('/', profileController.deleteUserProfile);

// Export both routers
export { authenticatedRouter as authenticatedProfileRouter };
export default router;