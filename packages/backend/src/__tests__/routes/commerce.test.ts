import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AccountMember } from '@oxy.so/core';
import type { MercariaStore, MercariaCollection } from '@mercaria.co/sdk';

const state = vi.hoisted(() => ({
  viewer: 'commerce-owner' as string | undefined,
  members: [] as AccountMember[],
  owner: 'commerce-owner',
  visible: true,
  blocked: false,
  privacyFailed: false,
  storeReads: vi.fn(),
  featured: vi.fn(),
  collectionProducts: vi.fn(),
}));
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { user: { id, kind: 'organization', name: {} } }])),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => ({}),
  createUserScopedOxyServices: () => ({
    privacy: {
      isBlocked: async () => {
        if (state.privacyFailed) throw new Error('Oxy unavailable');
        return state.blocked;
      },
    },
    accounts: { members: { list: async () => state.members } },
  }),
}));
vi.mock('../../utils/privacyHelpers', () => ({ canViewProfileDesign: async () => state.visible }));
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  requireOxyAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) =>
    state.viewer ? next() : res.sendStatus(401),
  getRequiredOxyUserId: () => state.viewer,
}));
vi.mock('../../middleware/security', () => {
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next();
  return { operatedAccountSettingsRateLimiter: pass, postDocumentsRateLimiter: pass };
});
vi.mock('../../services/commerce/mercariaClient', () => ({
  getMercariaClient: () => ({
    collections: { products: state.collectionProducts },
    stores: {
      featuredCollections: state.featured,
      lookup: async () => store(),
      resolveRef: async () => {
        state.storeReads();
        return store();
      },
    },
    links: { store: (value: MercariaStore) => value.url },
  }),
}));
import commerceRoutes from '../../routes/commerce';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { accountStorefronts } from '../../db/schema/commerce';
import { ERASURE_STEPS } from '../../services/accountErasure/erasureSteps';

function store(): MercariaStore {
  return {
    ref: { kind: 'store', id: 'store_commerce' },
    oxyAccountId: state.owner,
    handle: 'commerce-test',
    name: 'Commerce test',
    description: null,
    logoUrl: null,
    coverImageUrl: null,
    brandColor: '#123456',
    rating: null,
    reviewCount: 0,
    url: 'https://mercaria.co/stores/commerce-test',
  };
}
function featuredCollection(): MercariaCollection {
  return {
    ref: { kind: 'collection', id: 'collection_featured' },
    store: { kind: 'store', id: 'store_commerce' },
    title: 'Seller picks',
    description: null,
    image: null,
    url: 'https://mercaria.co/stores/commerce-test?collection=collection_featured',
  };
}
const app = express();
app.use(express.json());
app.use((req: express.Request & { user?: { id: string } }, _res, next) => {
  if (state.viewer) req.user = { id: state.viewer };
  next();
});
app.use('/commerce', commerceRoutes);
const target = '/commerce/accounts/commerce-owner';

beforeAll(connectPostgres);
beforeEach(async () => {
  state.viewer = 'commerce-owner';
  state.owner = 'commerce-owner';
  state.members = [];
  state.visible = true;
  state.blocked = false;
  state.privacyFailed = false;
  state.featured.mockReset().mockResolvedValue({ items: [featuredCollection()], nextCursor: null });
  state.collectionProducts.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  await getDb()
    .delete(accountStorefronts)
    .where(eq(accountStorefronts.oxyAccountId, 'commerce-owner'));
});
afterAll(async () => {
  await getDb()
    .delete(accountStorefronts)
    .where(eq(accountStorefronts.oxyAccountId, 'commerce-owner'));
  await closePostgres();
});

describe('store connection identity and current authority', () => {
  it('stores only a stable ref and current SDK ownership, then removes the link on disconnect', async () => {
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
    const [row] = await getDb()
      .select()
      .from(accountStorefronts)
      .where(eq(accountStorefronts.oxyAccountId, 'commerce-owner'));
    expect(row.mercariaRef).toBe('mercaria:store:store_commerce');
    expect((await request(app).get(target).expect(200)).body.state).toBe('available');
    await request(app).delete(target).expect(204);
    expect((await request(app).get(target).expect(200)).body.state).toBe('disconnected');
  });
  it('rejects a different store owner and a caller without account authority before any write', async () => {
    state.owner = 'someone-else';
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(403);
    state.owner = 'commerce-owner';
    state.viewer = 'someone-else';
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(403);
    expect(
      await getDb()
        .select()
        .from(accountStorefronts)
        .where(eq(accountStorefronts.oxyAccountId, 'commerce-owner')),
    ).toEqual([]);
  });
  it('rechecks revoked operator membership for each mutation, preserving another account’s link', async () => {
    state.viewer = 'operator';
    state.members = [
      {
        _id: 'member-commerce',
        accountId: 'commerce-owner',
        memberUserId: 'operator',
        role: 'editor',
        permissions: ['account:act_as'],
        inherit: true,
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
    state.members = [];
    await request(app).delete(target).expect(403);
    expect((await request(app).get(target).expect(200)).body.state).toBe('available');
  });
  it('hides a transferred store and private profile without exposing stale store data', async () => {
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
    state.owner = 'new-owner';
    expect((await request(app).get(target).expect(200)).body).toEqual({ state: 'gone' });
    state.visible = false;
    state.storeReads.mockClear();
    await request(app).get(target).expect(404);
    expect(state.storeReads).not.toHaveBeenCalled();
  });
  it('requires authentication and rejects caller-supplied owner claims', async () => {
    state.viewer = undefined;
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(401);
    state.viewer = 'commerce-owner';
    await request(app)
      .put(target)
      .send({ handle: 'commerce-test', oxyAccountId: 'commerce-owner' })
      .expect(400);
  });
  it('erases the local connection without touching Mercaria catalog ownership', async () => {
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
    const step = ERASURE_STEPS['account_storefronts.oxyAccountId'];
    expect(await step.apply({ oxyUserId: 'commerce-owner' })).toBe(1);
    expect(await step.apply({ oxyUserId: 'commerce-owner' })).toBe(0);
    expect((await request(app).get(target).expect(200)).body.state).toBe('disconnected');
  });
});

describe('storefront privacy relationship', () => {
  it('does not disclose store data to a blocked viewer or when the block check fails', async () => {
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
    state.viewer = 'other-viewer';
    state.blocked = true;
    state.storeReads.mockClear();
    await request(app).get(target).expect(404);
    await request(app).get(`${target}/products`).expect(404);
    expect(state.storeReads).not.toHaveBeenCalled();
    state.blocked = false;
    state.privacyFailed = true;
    await request(app).get(target).expect(503);
    expect(state.storeReads).not.toHaveBeenCalled();
  });
});

describe('anonymous commerce aggregates', () => {
  const metrics = '/commerce/metrics/stores/commerce-owner';
  it('accepts only bounded interaction events and exposes totals only to the current owner', async () => {
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
    await request(app).post(metrics).send({ event: 'conversion' }).expect(400);
    await request(app).post(metrics).send({ event: 'open', viewerId: 'tracking' }).expect(400);
    state.viewer = undefined;
    await request(app).post(metrics).send({ event: 'open' }).expect(204);
    await request(app).get(metrics).expect(401);
    state.viewer = 'other-viewer';
    await request(app).get(metrics).expect(403);
    state.viewer = 'commerce-owner';
    const response = await request(app).get(metrics).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ suppressed: true, opens: null, handoffs: null });
  });
  it('rejects events for blocked, disconnected and transferred storefronts', async () => {
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
    state.viewer = 'blocked-viewer';
    state.blocked = true;
    await request(app).post(metrics).send({ event: 'open' }).expect(404);
    state.viewer = 'commerce-owner';
    state.blocked = false;
    state.owner = 'new-owner';
    await request(app).post(metrics).send({ event: 'open' }).expect(404);
    await request(app).delete(target).expect(204);
    await request(app).post(metrics).send({ event: 'open' }).expect(404);
  });
});

describe('current seller-selected shelves', () => {
  beforeEach(async () => {
    await request(app).put(target).send({ handle: 'commerce-test' }).expect(200);
  });
  const products = `${target}/featured-collections/collection_featured/products`;
  it('delegates collection selection and product pages without changing canonical order', async () => {
    const list = await request(app).get(`${target}/featured-collections?limit=2`).expect(200);
    expect(list.body.items).toEqual([featuredCollection()]);
    expect(state.featured).toHaveBeenCalledWith(
      { kind: 'store', id: 'store_commerce' },
      { limit: 2, cursor: undefined },
    );
    state.collectionProducts.mockResolvedValue({
      items: [
        { ref: { kind: 'product', id: 'second' } },
        { ref: { kind: 'product', id: 'first' } },
      ],
      nextCursor: 'next',
    });
    const page = await request(app).get(`${products}?cursor=previous&limit=3`).expect(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body.items.map((item: { ref: { id: string } }) => item.ref.id)).toEqual([
      'second',
      'first',
    ]);
    expect(state.collectionProducts).toHaveBeenCalledWith(featuredCollection().ref, {
      cursor: 'previous',
      limit: 3,
    });
  });
  it('stops a withdrawn selection before any product read, including stale pagination', async () => {
    state.featured.mockResolvedValue({ items: [], nextCursor: null });
    await request(app).get(`${products}?cursor=old`).expect(404);
    expect(state.collectionProducts).not.toHaveBeenCalled();
  });
  it('rejects cross-store selection and provider failure without serving stale products', async () => {
    state.featured.mockResolvedValue({
      items: [{ ...featuredCollection(), store: { kind: 'store', id: 'another_store' } }],
      nextCursor: null,
    });
    await request(app).get(products).expect(404);
    state.featured.mockRejectedValue(new Error('Provider unavailable'));
    await request(app).get(products).expect(503);
    expect(state.collectionProducts).not.toHaveBeenCalled();
  });
  it('applies account visibility, blocks, and store ownership transfer before selection reads', async () => {
    state.viewer = 'unrelated-viewer';
    state.visible = false;
    await request(app).get(products).expect(404);
    state.visible = true;
    state.blocked = true;
    await request(app).get(`${target}/featured-collections`).expect(404);
    state.blocked = false;
    state.owner = 'new-owner';
    await request(app).get(products).expect(404);
    expect(state.featured).not.toHaveBeenCalled();
    expect(state.collectionProducts).not.toHaveBeenCalled();
  });
  it('refuses search/sort filters on curated ordering and excessive page sizes', async () => {
    for (const path of [
      `${products}?sort=newest`,
      `${products}?limit=21`,
      `${target}/featured-collections?query=featured`,
    ]) {
      await request(app).get(path).expect(400);
    }
    expect(state.featured).not.toHaveBeenCalled();
  });
});
