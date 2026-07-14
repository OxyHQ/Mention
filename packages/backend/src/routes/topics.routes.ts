import { Router, Request, Response } from 'express';
import { topicService } from '../services/TopicService';
import { TopicType } from '@mention/shared-types';
import { queryInt, queryString } from '../utils/queryParams';

const router = Router();

/** Topic listing page size (`GET /topics`). */
const DEFAULT_TOPIC_LIMIT = 20;
const MAX_TOPIC_LIMIT = 100;

/** Autocomplete page size (`GET /topics/search`). */
const DEFAULT_TOPIC_SEARCH_LIMIT = 10;
const MAX_TOPIC_SEARCH_LIMIT = 50;

function toTopicType(raw: string): TopicType | undefined {
  return Object.values(TopicType).find((topicType) => topicType === raw);
}

/**
 * GET /api/topics
 * Proxies to Oxy API for topic listing.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // A type the caller actually sent but that is not a TopicType is still a 400;
    // an absent (or tampered, which reads as absent) type means "no type filter".
    const rawType = queryString(req.query.type);
    const type = rawType === undefined ? undefined : toTopicType(rawType);
    const query = queryString(req.query.q);
    const locale = queryString(req.query.locale);
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_TOPIC_LIMIT, MAX_TOPIC_LIMIT);
    const offset = Math.max(queryInt(req.query.offset) || 0, 0);

    if (rawType !== undefined && type === undefined) {
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
    const locale = queryString(req.query.locale);
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
    const query = queryString(req.query.q);
    if (!query || query.trim().length === 0) {
      return res.json({ topics: [] });
    }

    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_TOPIC_SEARCH_LIMIT, MAX_TOPIC_SEARCH_LIMIT);
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
