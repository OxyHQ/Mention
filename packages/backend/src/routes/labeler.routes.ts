import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { validateBody, validateObjectId } from '../middleware/validate';
import { LabelService } from '../services/LabelService';
import UserSettings from '../models/UserSettings';
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
router.get('/', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const labelers = await LabelService.getLabelers(search ? { search } : undefined);

    // Determine which labelers the current user is subscribed to
    const settings = await UserSettings.findOne({ oxyUserId: userId }).lean();
    const subscribedSet = new Set<string>(
      settings?.privacy?.labelPreferences?.subscribedLabelers ?? []
    );

    const items = labelers.map((l: any) => {
      const id = String(l._id);
      return { ...l, id, isSubscribed: subscribedSet.has(id) };
    });

    res.json({ items, total: items.length });
  } catch (error) {
    logger.error('[Labelers] List labelers error:', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to list labelers' });
  }
});

// ---------------------------------------------------------------------------
// POST / — create a labeler
// ---------------------------------------------------------------------------
router.post('/', validateBody(createLabelerSchema), async (req: any, res) => {
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

    const result = { ...(labeler as any).toObject(), id: String(labeler._id) };
    res.status(201).json(result);
  } catch (error) {
    logger.error('[Labelers] Create labeler error:', { userId: req.user?.id, error, body: req.body });
    res.status(500).json({ error: 'Failed to create labeler' });
  }
});

// ---------------------------------------------------------------------------
// GET /content/:type/:id — get all labels for a content piece
// (placed before /:id to avoid route shadowing)
// ---------------------------------------------------------------------------
router.get('/content/:type/:id', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { type, id } = req.params;
    if (type !== 'post' && type !== 'user') {
      return res.status(400).json({ error: "type must be 'post' or 'user'" });
    }

    const labels = await LabelService.getLabelsForContent(type as 'post' | 'user', id);
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
router.delete('/labels/:id', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid label id' });
    }

    await LabelService.removeLabel(req.params.id, userId);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('[Labelers] Remove label error:', { userId: req.user?.id, labelId: req.params.id, error });
    if (error?.message === 'Label not found') return res.status(404).json({ error: error.message });
    if (error?.message === 'Not authorised to remove this label') return res.status(403).json({ error: error.message });
    res.status(500).json({ error: 'Failed to remove label' });
  }
});

// ---------------------------------------------------------------------------
// PUT /preferences — update label action preferences in UserSettings
// ---------------------------------------------------------------------------
router.put('/preferences', validateBody(updatePreferencesSchema), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { labelActions } = req.body;

    await UserSettings.findOneAndUpdate(
      { oxyUserId: userId },
      { $set: { 'privacy.labelPreferences.labelActions': labelActions } },
      { upsert: true, new: true }
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Labelers] Update preferences error:', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to update label preferences' });
  }
});

// ---------------------------------------------------------------------------
// GET /:id — get a labeler by id with isSubscribed flag
// ---------------------------------------------------------------------------
router.get('/:id', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const labeler = await LabelService.getLabelerById(req.params.id);
    if (!labeler) return res.status(404).json({ error: 'Labeler not found' });

    const settings = await UserSettings.findOne({ oxyUserId: userId }).lean();
    const subscribedList: string[] = settings?.privacy?.labelPreferences?.subscribedLabelers ?? [];
    const isSubscribed = subscribedList.includes(req.params.id);

    const id = String((labeler as any)._id);
    res.json({ ...(labeler as any), id, isSubscribed });
  } catch (error) {
    logger.error('[Labelers] Get labeler error:', { userId: req.user?.id, labelerId: req.params.id, error });
    res.status(500).json({ error: 'Failed to get labeler' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/subscribe — subscribe current user to a labeler
// ---------------------------------------------------------------------------
router.post('/:id/subscribe', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await LabelService.subscribeToLabeler(userId, req.params.id);
    res.json({ success: true, subscribed: true });
  } catch (error: any) {
    logger.error('[Labelers] Subscribe error:', { userId: req.user?.id, labelerId: req.params.id, error });
    if (error?.message === 'Labeler not found') return res.status(404).json({ error: error.message });
    res.status(500).json({ error: 'Failed to subscribe to labeler' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id/subscribe — unsubscribe current user from a labeler
// ---------------------------------------------------------------------------
router.delete('/:id/subscribe', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await LabelService.unsubscribeFromLabeler(userId, req.params.id);
    res.json({ success: true, subscribed: false });
  } catch (error: any) {
    logger.error('[Labelers] Unsubscribe error:', { userId: req.user?.id, labelerId: req.params.id, error });
    if (error?.message === 'Labeler not found') return res.status(404).json({ error: error.message });
    res.status(500).json({ error: 'Failed to unsubscribe from labeler' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/labels — apply a label (creator only)
// ---------------------------------------------------------------------------
router.post('/:id/labels', validateObjectId('id'), validateBody(applyLabelSchema), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const labelerId = req.params.id;

    // Only the labeler's creator may apply labels through this endpoint
    const labeler = await LabelService.getLabelerById(labelerId);
    if (!labeler) return res.status(404).json({ error: 'Labeler not found' });
    if ((labeler as any).creatorId !== userId) {
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

    const result = { ...(label as any).toObject(), id: String(label._id) };
    res.status(201).json(result);
  } catch (error: any) {
    logger.error('[Labelers] Apply label error:', { userId: req.user?.id, labelerId: req.params.id, error, body: req.body });
    if (error?.message?.includes('does not exist in this labeler')) return res.status(400).json({ error: error.message });
    if (error?.message === 'Labeler not found') return res.status(404).json({ error: error.message });
    if ((error as any)?.code === 11000) return res.status(409).json({ error: 'Label already applied' });
    res.status(500).json({ error: 'Failed to apply label' });
  }
});

export default router;
