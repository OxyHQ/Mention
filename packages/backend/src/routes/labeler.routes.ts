import { Router, type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { z } from 'zod';
import { isUniqueViolation } from '@oxyhq/db';
import { validateBody, validateObjectId } from '../middleware/validate';
import { LabelService, type LabelActionPreference } from '../services/LabelService';
import { logger } from '../utils/logger';

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createLabelerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less').transform(s => s.trim()),
  description: z.string().max(500, 'Description must be 500 characters or less').optional().transform(s => s?.trim()),
  labelDefinitions: z.array(z.object({
    slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    defaultAction: z.enum(['show', 'warn', 'blur', 'hide']),
  })).max(50, 'Maximum 50 label definitions allowed').optional().default([]),
});

const applyLabelSchema = z.object({
  targetType: z.enum(['post', 'user']),
  targetId: z.string().min(1, 'targetId is required'),
  labelSlug: z.string().min(1, 'labelSlug is required'),
  reason: z.string().max(500).optional(),
});

const updatePreferencesSchema = z.object({
  labelActions: z.array(z.object({
    labelerId: z.string().min(1),
    labelSlug: z.string().min(1),
    action: z.enum(['hide', 'warn', 'blur', 'show']),
  })).max(500, 'Maximum 500 label action overrides allowed'),
});

// ---------------------------------------------------------------------------
// GET / — list labelers, with optional ?search= and isSubscribed flag
// ---------------------------------------------------------------------------
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const [labelers, subscribedIds] = await Promise.all([
      LabelService.getLabelers(search ? { search } : undefined),
      LabelService.getSubscribedLabelerIds(userId),
    ]);

    const subscribedSet = new Set<string>(subscribedIds);
    const items = labelers.map((labeler) => ({
      ...labeler,
      isSubscribed: subscribedSet.has(labeler.id),
    }));

    res.json({ items, total: items.length });
  } catch (error) {
    logger.error('[Labelers] List labelers error:', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to list labelers' });
  }
});

// ---------------------------------------------------------------------------
// POST / — create a labeler
// ---------------------------------------------------------------------------
router.post('/', validateBody(createLabelerSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { name, description, labelDefinitions } = req.body;

    const labeler = await LabelService.createLabeler({
      name,
      description,
      creatorId: userId,
      labelDefinitions,
    });

    res.status(201).json(labeler);
  } catch (error) {
    logger.error('[Labelers] Create labeler error:', { userId: req.user?.id, error, body: req.body });
    res.status(500).json({ error: 'Failed to create labeler' });
  }
});

// ---------------------------------------------------------------------------
// GET /content/:type/:id — get all labels for a content piece
// (placed before /:id to avoid route shadowing)
// ---------------------------------------------------------------------------
router.get('/content/:type/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const type = String(req.params.type);
    const id = String(req.params.id);
    if (type !== 'post' && type !== 'user') {
      return res.status(400).json({ error: "type must be 'post' or 'user'" });
    }

    const labels = await LabelService.getLabelsForContent(type, id);
    res.json({ items: labels, total: labels.length });
  } catch (error) {
    logger.error('[Labelers] Get content labels error:', { userId: req.user?.id, params: req.params, error });
    res.status(500).json({ error: 'Failed to get labels for content' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /labels/:id — remove a content label
// (placed before /:id to avoid route shadowing)
// ---------------------------------------------------------------------------
// The hand-rolled `ObjectId.isValid` 400 this route used to carry is now the
// shared `validateObjectId`, same as every other id param here — it keeps the
// documented 400 while accepting both live id shapes.
router.delete('/labels/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const labelId = String(req.params.id);
    await LabelService.removeLabel(labelId, userId);
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Labelers] Remove label error:', { userId: req.user?.id, labelId: req.params.id, error });
    const message = error instanceof Error ? error.message : '';
    if (message === 'Label not found') return res.status(404).json({ error: message });
    if (message === 'Not authorised to remove this label') return res.status(403).json({ error: message });
    res.status(500).json({ error: 'Failed to remove label' });
  }
});

// ---------------------------------------------------------------------------
// PUT /preferences — replace label action overrides for the labelers named
// ---------------------------------------------------------------------------
router.put('/preferences', validateBody(updatePreferencesSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Per-labeler REPLACE, not a whole-array rewrite: overrides for labelers this
    // request does not name are left exactly as they are. The read-merge-write the
    // Mongo version used lost one of two concurrent saves.
    const labelActions: LabelActionPreference[] = req.body.labelActions;
    await LabelService.setLabelActions(userId, labelActions);

    res.json({ success: true });
  } catch (error) {
    logger.error('[Labelers] Update preferences error:', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to update label preferences' });
  }
});

// ---------------------------------------------------------------------------
// GET /:id — get a labeler by id with isSubscribed flag
// ---------------------------------------------------------------------------
router.get('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const labelerId = String(req.params.id);
    const [labeler, subscribedIds] = await Promise.all([
      LabelService.getLabelerById(labelerId),
      LabelService.getSubscribedLabelerIds(userId),
    ]);
    if (!labeler) return res.status(404).json({ error: 'Labeler not found' });

    res.json({ ...labeler, isSubscribed: subscribedIds.includes(labelerId) });
  } catch (error) {
    logger.error('[Labelers] Get labeler error:', { userId: req.user?.id, labelerId: req.params.id, error });
    res.status(500).json({ error: 'Failed to get labeler' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/subscribe — subscribe current user to a labeler
// ---------------------------------------------------------------------------
router.post('/:id/subscribe', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await LabelService.subscribeToLabeler(userId, String(req.params.id));
    res.json({ success: true, subscribed: true });
  } catch (error: unknown) {
    logger.error('[Labelers] Subscribe error:', { userId: req.user?.id, labelerId: req.params.id, error });
    if (error instanceof Error && error.message === 'Labeler not found') return res.status(404).json({ error: error.message });
    res.status(500).json({ error: 'Failed to subscribe to labeler' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id/subscribe — unsubscribe current user from a labeler
// ---------------------------------------------------------------------------
router.delete('/:id/subscribe', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await LabelService.unsubscribeFromLabeler(userId, String(req.params.id));
    res.json({ success: true, subscribed: false });
  } catch (error: unknown) {
    logger.error('[Labelers] Unsubscribe error:', { userId: req.user?.id, labelerId: req.params.id, error });
    if (error instanceof Error && error.message === 'Labeler not found') return res.status(404).json({ error: error.message });
    res.status(500).json({ error: 'Failed to unsubscribe from labeler' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/labels — apply a label (creator only)
// ---------------------------------------------------------------------------
router.post('/:id/labels', validateObjectId('id'), validateBody(applyLabelSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const labelerId = String(req.params.id);

    // Only the labeler's creator may apply labels through this endpoint
    const labeler = await LabelService.getLabelerById(labelerId);
    if (!labeler) return res.status(404).json({ error: 'Labeler not found' });
    if (labeler.creatorId !== userId) {
      return res.status(403).json({ error: 'Only the labeler creator may apply labels' });
    }

    const { targetType, targetId, labelSlug, reason } = req.body;

    const label = await LabelService.applyLabel({
      labelerId,
      targetType,
      targetId,
      labelSlug,
      createdBy: userId,
      reason,
    });

    res.status(201).json(label);
  } catch (error) {
    logger.error('[Labelers] Apply label error:', { userId: req.user?.id, labelerId: req.params.id, error, body: req.body });
    const message = error instanceof Error ? error.message : '';
    if (message.includes('does not exist in this labeler')) return res.status(400).json({ error: message });
    if (message === 'Labeler not found') return res.status(404).json({ error: message });
    // NAMED: this route answers 409 for "already applied" and nothing else. A
    // bare 23505 check would report any future unique index as a duplicate label.
    if (isUniqueViolation(error, 'content_labels_labeler_target_slug_key')) {
      return res.status(409).json({ error: 'Label already applied' });
    }
    res.status(500).json({ error: 'Failed to apply label' });
  }
});

export default router;
