import { canReadAccount, resolveReadableCommercePost } from '../services/commerce/access';
import {
  commerceMetricsSummary,
  recordCommerceMetric,
  type CommerceMetricTarget,
} from '../services/commerce/metrics';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireOxyAuth, getRequiredOxyUserId, type OxyAuthRequest } from '@oxy.so/core/server';
import { isMercariaError, parseMercariaRef } from '@mercaria.co/sdk';
import type { CommerceReference } from '@mention/shared-types/commerce';
import { getMercariaClient } from '../services/commerce/mercariaClient';
import { hydrateCommerceReferences } from '../services/commerce/mercariaHydration';
import {
  connectStorefront,
  disconnectStorefront,
  lookupStorefront,
  readStorefront,
  StorefrontOwnershipError,
} from '../services/commerce/storefronts';
import { assertCanPublishAsAccount, PublishAsAccessError } from '../services/publishAsAccount';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { isAccountErased } from '../services/accountErasure/erasedAccounts';
import {
  operatedAccountSettingsRateLimiter,
  postDocumentsRateLimiter,
} from '../middleware/security';
import { logger } from '../utils/logger';

const router = Router();
const accountIdSchema = z.string().min(1).max(128);
const searchSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(20),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'relevance']).optional(),
    inStock: z.enum(['true', 'false']).optional(),
  })
  .strict();

const pageSchema = z
  .object({
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(20),
  })
  .strict();

function failure(res: Response, error: unknown) {
  if (error instanceof PublishAsAccessError)
    return res.status(error.status).json({ message: error.message });
  if (error instanceof StorefrontOwnershipError)
    return res.status(403).json({ message: error.message });
  if (isMercariaError(error)) {
    const status =
      error.code === 'not_found' || error.code === 'gone'
        ? 404
        : error.code === 'bad_request' || error.code === 'validation_failed'
          ? 400
          : 503;
    return res.status(status).json({
      message: status === 404 ? 'Storefront unavailable' : 'Commerce is temporarily unavailable',
      retryable: error.retryable,
    });
  }
  logger.error('[Commerce] Request failed', error);
  return res.status(503).json({ message: 'Commerce is temporarily unavailable' });
}

async function canManageAccount(req: OxyAuthRequest, accountId: string): Promise<void> {
  if (await isAccountErased(accountId)) throw new PublishAsAccessError(404, 'Account unavailable');
  await assertCanPublishAsAccount({
    publishAsOxyUserId: accountId,
    callerId: getRequiredOxyUserId(req),
    memberReader: createUserScopedOxyServices(req),
  });
}

// One bounded presentation batch, independent of post/feed hydration and ranking.
router.post('/hydrate', postDocumentsRateLimiter, async (req: OxyAuthRequest, res: Response) => {
  const body = z
    .object({ refs: z.array(z.unknown()).min(1).max(24) })
    .strict()
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: 'Invalid commerce references' });
  const refs: CommerceReference[] = [];
  for (const value of body.data.refs) {
    const ref = parseMercariaRef(value);
    if (ref?.kind !== 'product' && ref?.kind !== 'collection')
      return res.status(400).json({ message: 'Invalid commerce reference' });
    refs.push(ref);
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ items: await hydrateCommerceReferences(refs) });
});

router.get('/products', postDocumentsRateLimiter, async (req: OxyAuthRequest, res: Response) => {
  const input = searchSchema.safeParse(req.query);
  if (!input.success) return res.status(400).json({ message: 'Invalid product search' });
  try {
    const { query, cursor, limit, sort, inStock } = input.data;
    res.setHeader('Cache-Control', 'no-store');
    return res.json(
      await getMercariaClient().products.search({
        query,
        cursor,
        limit,
        sort,
        inStock: inStock === undefined ? undefined : inStock === 'true',
      }),
    );
  } catch (error) {
    return failure(res, error);
  }
});

router.get(
  '/accounts/:accountId',
  postDocumentsRateLimiter,
  async (req: OxyAuthRequest, res: Response) => {
    const accountId = accountIdSchema.safeParse(req.params.accountId);
    if (!accountId.success) return res.status(400).json({ message: 'Invalid account' });
    try {
      if (!(await canReadAccount(req, accountId.data)))
        return res.status(404).json({ message: 'Storefront unavailable' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await readStorefront(accountId.data));
    } catch (error) {
      return failure(res, error);
    }
  },
);

router.get(
  '/accounts/:accountId/:list',
  postDocumentsRateLimiter,
  async (req: OxyAuthRequest, res: Response) => {
    const accountId = accountIdSchema.safeParse(req.params.accountId);
    const input = searchSchema.safeParse(req.query);
    if (
      !accountId.success ||
      !input.success ||
      !['products', 'collections', 'featured-collections'].includes(String(req.params.list)) ||
      (req.params.list === 'featured-collections' && !pageSchema.safeParse(req.query).success)
    )
      return res.status(400).json({ message: 'Invalid storefront request' });
    try {
      if (!(await canReadAccount(req, accountId.data)))
        return res.status(404).json({ message: 'Storefront unavailable' });
      const storefront = await readStorefront(accountId.data);
      if (storefront.state !== 'available')
        return res
          .status(storefront.state === 'unavailable' ? 503 : 404)
          .json({ message: 'Storefront unavailable' });
      const { query, cursor, limit, sort, inStock } = input.data;
      res.setHeader('Cache-Control', 'no-store');
      const client = getMercariaClient();
      return res.json(
        req.params.list === 'featured-collections'
          ? await client.stores.featuredCollections(storefront.store.ref, { cursor, limit })
          : req.params.list === 'collections'
            ? await client.stores.collections(storefront.store.ref, { cursor, limit })
            : await client.stores.products(storefront.store.ref, {
                query,
                cursor,
                limit,
                sort,
                inStock: inStock === undefined ? undefined : inStock === 'true',
              }),
      );
    } catch (error) {
      return failure(res, error);
    }
  },
);

router.get(
  '/accounts/:accountId/featured-collections/:collectionId/products',
  postDocumentsRateLimiter,
  async (req: OxyAuthRequest, res: Response) => {
    const accountId = accountIdSchema.safeParse(req.params.accountId);
    const collectionId = accountIdSchema.safeParse(req.params.collectionId);
    const page = pageSchema.safeParse(req.query);
    if (!accountId.success || !collectionId.success || !page.success)
      return res.status(400).json({ message: 'Invalid storefront request' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!(await canReadAccount(req, accountId.data)))
        return res.status(404).json({ message: 'Storefront unavailable' });
      const storefront = await readStorefront(accountId.data);
      if (storefront.state !== 'available')
        return res
          .status(storefront.state === 'unavailable' ? 503 : 404)
          .json({ message: 'Storefront unavailable' });
      const client = getMercariaClient();
      // The canonical selection is bounded to six shelves. Revalidate on every
      // page so a removed shelf cannot keep loading through a stale client ref.
      const selected = await client.stores.featuredCollections(storefront.store.ref, { limit: 20 });
      const collection = selected.items.find(
        (item) => item.ref.id === collectionId.data && item.store.id === storefront.store.ref.id,
      );
      if (!collection) return res.status(404).json({ message: 'Collection unavailable' });
      return res.json(await client.collections.products(collection.ref, page.data));
    } catch (error) {
      return failure(res, error);
    }
  },
);

router.put(
  '/accounts/:accountId',
  requireOxyAuth,
  operatedAccountSettingsRateLimiter,
  async (req: OxyAuthRequest, res: Response) => {
    const accountId = accountIdSchema.safeParse(req.params.accountId);
    const body = z
      .object({ handle: z.string().trim().min(1).max(128) })
      .strict()
      .safeParse(req.body);
    if (!accountId.success || !body.success)
      return res.status(400).json({ message: 'Enter a Mercaria store handle' });
    try {
      await canManageAccount(req, accountId.data);
      const store = await lookupStorefront(body.data.handle);
      const ref = await connectStorefront(accountId.data, store);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ accountId: accountId.data, ref });
    } catch (error) {
      return failure(res, error);
    }
  },
);

router.delete(
  '/accounts/:accountId',
  requireOxyAuth,
  operatedAccountSettingsRateLimiter,
  async (req: OxyAuthRequest, res: Response) => {
    const accountId = accountIdSchema.safeParse(req.params.accountId);
    if (!accountId.success) return res.status(400).json({ message: 'Invalid account' });
    try {
      await canManageAccount(req, accountId.data);
      await disconnectStorefront(accountId.data);
      return res.status(204).end();
    } catch (error) {
      return failure(res, error);
    }
  },
);

const metricEventSchema = z.object({ event: z.enum(['open', 'handoff']) }).strict();
async function resolveMetricTarget(
  req: OxyAuthRequest,
): Promise<{ target: CommerceMetricTarget; ownerId: string } | null> {
  const id = accountIdSchema.safeParse(req.params.id);
  if (!id.success) return null;
  if (req.params.kind === 'stores') {
    if (!(await canReadAccount(req, id.data))) return null;
    if ((await readStorefront(id.data)).state !== 'available') return null;
    return { target: { kind: 'store', id: id.data }, ownerId: id.data };
  }
  if (req.params.kind !== 'posts') return null;
  return resolveReadableCommercePost(req, id.data);
}
router.post(
  '/metrics/:kind/:id',
  postDocumentsRateLimiter,
  async (req: OxyAuthRequest, res: Response) => {
    const event = metricEventSchema.safeParse(req.body);
    if (!event.success) return res.status(400).json({ message: 'Invalid commerce event' });
    try {
      const resolved = await resolveMetricTarget(req);
      if (!resolved) return res.sendStatus(404);
      await recordCommerceMetric(resolved.target, event.data.event);
      return res.status(204).end();
    } catch (error) {
      return failure(res, error);
    }
  },
);
router.get(
  '/metrics/:kind/:id',
  requireOxyAuth,
  postDocumentsRateLimiter,
  async (req: OxyAuthRequest, res: Response) => {
    try {
      const resolved = await resolveMetricTarget(req);
      if (!resolved) return res.sendStatus(404);
      await canManageAccount(req, resolved.ownerId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await commerceMetricsSummary(resolved.target));
    } catch (error) {
      return failure(res, error);
    }
  },
);

export default router;
