import { getRequiredOxyUserId, type OxyAuthRequest } from '@oxy.so/core/server';
import { Router } from 'express';
import { deckWorkspaceService } from '../services/deck/deckWorkspaceService';

/** Mounted exclusively under authenticatedApi: the session owns this private document. */
const router = Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
router.get('/', async (req: OxyAuthRequest, res) => {
  res.json(await deckWorkspaceService.load(getRequiredOxyUserId(req)));
});
router.put('/', async (req: OxyAuthRequest, res) => {
  const result = await deckWorkspaceService.update(getRequiredOxyUserId(req), req.body);
  res.status(result.status).json(result.body);
});
export default router;
