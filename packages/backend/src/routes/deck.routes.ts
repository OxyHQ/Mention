import { DECK_LIMITS } from '@mention/shared-types/deck';
import { getRequiredOxyUserId, type OxyAuthRequest } from '@oxy.so/core/server';
import { Router } from 'express';
import { loadDeckWorkspace, saveDeckWorkspace } from '../db/deck/deckWorkspaceRepository';
import { deckWorkspaceUpdateSchema } from '../services/deck/deckWorkspaceValidation';

/** Mounted exclusively under authenticatedApi: the session owns this private document. */
const router = Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
router.get('/', async (req: OxyAuthRequest, res) => {
  res.json(await loadDeckWorkspace(getRequiredOxyUserId(req)));
});
router.put('/', async (req: OxyAuthRequest, res) => {
  if (Buffer.byteLength(JSON.stringify(req.body) ?? '', 'utf8') > DECK_LIMITS.payloadBytes) {
    res.status(413).json({ error: 'Deck workspace is too large' });
    return;
  }
  const parsed = deckWorkspaceUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid Deck workspace', issues: parsed.error.issues });
    return;
  }
  const result = await saveDeckWorkspace(getRequiredOxyUserId(req), parsed.data);
  res.status(result.saved ? 200 : 409).json(result.workspace);
});
export default router;
