import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AccountMember } from '@oxy.so/core';
import type { MercariaStore } from '@mercaria.co/sdk';

const state = vi.hoisted(() => ({
  viewer: 'commerce-owner' as string | undefined,
  members: [] as AccountMember[],
  owner: 'commerce-owner',
  visible: true,
  storeReads: vi.fn(),
}));
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { user: { id, kind: 'organization', name: {} } }])),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => ({}),
  createUserScopedOxyServices: () => ({
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
    stores: {
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
    brandColor: null,
    rating: null,
    reviewCount: 0,
    url: 'https://mercaria.co/stores/commerce-test',
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
