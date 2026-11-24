/**
 * The paid Boost, from the buyer's side (docs/boost.md).
 *
 *   GET    /promotions/tiers  what can be bought (no prices: those come from the
 *                             payment catalogue)
 *   POST   /promotions        start a purchase of a tier for one of your posts
 *   GET    /promotions        your promotions, newest first (`postId` narrows it)
 *   DELETE /promotions/:id    cancel a purchase that has not been paid
 *
 * Everything answers 404 while `MtnConfig.promotion.enabled` is false, so the
 * feature does not exist as far as a client can tell until it is switched on.
 */

import { protectionsFor } from '@oxy.so/contracts';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { MtnConfig } from '@mention/shared-types';
import {
  cancelPromotionPurchase,
  listBuyerPromotions,
  promotionView,
} from '../services/promotion/buyerPromotions';
import { startPromotionPurchase } from '../services/promotion/purchase';
import { ageBandOf } from '../utils/ageBand';
import { logger } from '../utils/logger';

const router = Router();

const purchaseSchema = z.object({ postId: z.string().min(1), tier: z.string().min(1) });

const switchedOff = (res: Response) => res.status(404).json({ message: 'Not found' });

router.get('/tiers', (_req, res) => {
  if (!MtnConfig.promotion.enabled) return switchedOff(res);
  res.json({ tiers: MtnConfig.promotion.tiers });
});

router.post('/', async (req: AuthRequest, res: Response) => {
  if (!MtnConfig.promotion.enabled) return switchedOff(res);
  const buyer = req.user?.id;
  if (!buyer) return res.status(401).json({ message: 'Authentication required' });
  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'postId and tier are required' });

  try {
    const result = await startPromotionPurchase({
      buyerOxyUserId: buyer,
      buyerIsProtected: protectionsFor(ageBandOf(req.user)).feedProfile === 'protected',
      postId: parsed.data.postId,
      tierId: parsed.data.tier,
    });
    if (result.ok) return res.status(201).json({ promotion: promotionView(result.promotion) });
    switch (result.reason) {
      case 'unknown-tier':
        return res.status(400).json({ message: 'Unknown tier' });
      case 'post-not-found':
        return res.status(404).json({ message: 'Post not found' });
      case 'ineligible':
        return res
          .status(422)
          .json({ message: 'Post cannot be promoted', reasons: result.ineligibility });
      default:
        return switchedOff(res);
    }
  } catch (error) {
    logger.error('Failed to start a promotion purchase', { error });
    return res.status(500).json({ message: 'Could not start the purchase' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  if (!MtnConfig.promotion.enabled) return switchedOff(res);
  const buyer = req.user?.id;
  if (!buyer) return res.status(401).json({ message: 'Authentication required' });
  const postId = typeof req.query.postId === 'string' ? req.query.postId : undefined;
  try {
    res.json({ promotions: await listBuyerPromotions(buyer, postId) });
  } catch (error) {
    logger.error('Failed to list promotions', { error });
    res.status(500).json({ message: 'Could not list promotions' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  if (!MtnConfig.promotion.enabled) return switchedOff(res);
  const buyer = req.user?.id;
  if (!buyer) return res.status(401).json({ message: 'Authentication required' });
  try {
    const outcome = await cancelPromotionPurchase(buyer, String(req.params.id));
    if (outcome === 'not-found') return res.status(404).json({ message: 'Not found' });
    if (outcome === 'not-cancelable')
      return res.status(409).json({ message: 'Only an unpaid purchase can be canceled' });
    res.status(204).end();
  } catch (error) {
    logger.error('Failed to cancel a promotion', { error });
    res.status(500).json({ message: 'Could not cancel the purchase' });
  }
});

export default router;
