import { Router, Request, Response } from 'express';
import { topicService } from '../services/TopicService';
import { TopicType } from '@mention/shared-types';

const router = Router();

/**
 * GET /api/topics
 * Proxies to Oxy API for topic listing.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as TopicType | undefined;
    const query = req.query.q as string | undefined;
    const locale = req.query.locale as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    if (type && !Object.values(TopicType).includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${Object.values(TopicType).join(', ')}` });
    }

    const result = await topicService.list({ type, query, limit, offset, locale });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch topics' });
  }
});

/**
 * GET /api/topics/categories
 * Returns all category-type topics. Optional locale for translations.
 */
router.get('/categories', async (req: Request, res: Response) => {
  try {
    const locale = req.query.locale as string | undefined;
    const categories = await topicService.getCategories(locale);
    res.json({ topics: categories });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

/**
 * GET /api/topics/search?q=...
 * Autocomplete search for topics.
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    if (!query || query.trim().length === 0) {
      return res.json({ topics: [] });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const topics = await topicService.search(query, limit);
    res.json({ topics });
  } catch (error) {
    res.status(500).json({ error: 'Failed to search topics' });
  }
});

/**
 * GET /api/topics/:slug
 * Get a single topic by slug.
 */
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    const topic = await topicService.getBySlug(slug);
    if (!topic) {
      return res.status(404).json({ error: 'Topic not found' });
    }
    res.json(topic);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch topic' });
  }
});

export default router;
