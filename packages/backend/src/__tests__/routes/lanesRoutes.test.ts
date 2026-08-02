import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { MAX_LANES_PER_OWNER, MAX_MUTED_LANES } from '@mention/shared-types';

/**
 * The Lanes API.
 *
 * Three things here fail SILENTLY if they regress, which is why each has a test
 * of its own rather than being implied by the happy path:
 *
 *  1. **The delete order.** Unset `laneId` on the posts, THEN drop the mutes,
 *     THEN drop the lane. Backwards, posts point at a lane that no longer exists:
 *     hydration emits no chip (harmless) but the profile exclusion query stops
 *     matching, so posts the owner had tucked away REAPPEAR on their profile.
 *  2. **The 409 is the unique index, not the pre-check.** `countDocuments` is not
 *     a lock, so a duplicate name is caught by the constraint or not at all.
 *  3. **Muting your own lane is refused.** It would delete your own posts from
 *     your own Following feed.
 */

const VIEWER_ID = 'viewer-1';
const OTHER_USER_ID = 'stranger-9';
const LANE_ID = '65b0c9178fcdefaf81988ffb';
const OTHER_LANE_ID = '65b0c9178fcdefaf81988ffc';

/** Ordered log of the writes a request performed, for the delete-order test. */
const writes: string[] = [];

const laneFind = vi.fn();
const laneFindOne = vi.fn();
const laneFindById = vi.fn();
const laneCreate = vi.fn();
const laneCount = vi.fn();
const laneDeleteOne = vi.fn();
vi.mock('../../models/Lane', () => ({
  Lane: {
    find: (...args: unknown[]) => laneFind(...args),
    findOne: (...args: unknown[]) => laneFindOne(...args),
    findById: (...args: unknown[]) => laneFindById(...args),
    create: (...args: unknown[]) => laneCreate(...args),
    countDocuments: (...args: unknown[]) => laneCount(...args),
    deleteOne: (...args: unknown[]) => {
      writes.push('lane.deleteOne');
      return laneDeleteOne(...args);
    },
  },
  // The real normalization, so a route test cannot pass against a different one.
  normalizeLaneName: (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase(),
}));

const muteFind = vi.fn();
const muteFindOne = vi.fn();
const muteCreate = vi.fn();
const muteCount = vi.fn();
const muteDeleteOne = vi.fn();
const muteDeleteMany = vi.fn();
vi.mock('../../models/LaneMute', () => ({
  LaneMute: {
    find: (...args: unknown[]) => muteFind(...args),
    findOne: (...args: unknown[]) => muteFindOne(...args),
    create: (...args: unknown[]) => muteCreate(...args),
    countDocuments: (...args: unknown[]) => muteCount(...args),
    deleteOne: (...args: unknown[]) => muteDeleteOne(...args),
    deleteMany: (...args: unknown[]) => {
      writes.push('laneMute.deleteMany');
      return muteDeleteMany(...args);
    },
  },
}));

const postUpdateMany = vi.fn();
const postAggregate = vi.fn();
vi.mock('../../models/Post', () => ({
  Post: {
    updateMany: (...args: unknown[]) => {
      writes.push('post.updateMany');
      return postUpdateMany(...args);
    },
    aggregate: (...args: unknown[]) => postAggregate(...args),
  },
}));

const resolveUserSummaries = vi.fn();
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return {
    ...actual,
    requireOxyAuth: (_req: unknown, _res: unknown, next: NextFunction) => next(),
    getRequiredOxyUserId: (req: OxyAuthRequest) => req.user?.id ?? '',
  };
});

import lanesRouter, { publicLanesRouter } from '../../routes/lanes.routes';

/** A chainable stand-in for the query builders these routes use. */
function chain<T>(value: T) {
  const link = {
    select: () => link,
    sort: () => link,
    limit: () => link,
    lean: () => Promise.resolve(value),
  };
  return link;
}

function laneDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: LANE_ID,
    ownerType: 'user',
    ownerId: VIEWER_ID,
    name: 'Dev',
    nameLower: 'dev',
    displayMode: 'mixed',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    req.user = { id: VIEWER_ID };
    next();
  });
  app.use('/lanes', publicLanesRouter);
  app.use('/lanes', lanesRouter);
  return app;
}

beforeEach(() => {
  writes.length = 0;
  for (const fn of [
    laneFind, laneFindOne, laneFindById, laneCreate, laneCount, laneDeleteOne,
    muteFind, muteFindOne, muteCreate, muteCount, muteDeleteOne, muteDeleteMany,
    postUpdateMany, postAggregate, resolveUserSummaries,
  ]) {
    fn.mockReset();
  }
  laneFind.mockReturnValue(chain([]));
  laneFindOne.mockReturnValue(chain(null));
  laneFindById.mockReturnValue(chain(null));
  laneCount.mockResolvedValue(0);
  laneDeleteOne.mockResolvedValue({ deletedCount: 1 });
  muteFind.mockReturnValue(chain([]));
  muteFindOne.mockReturnValue(chain(null));
  muteCount.mockResolvedValue(0);
  muteCreate.mockResolvedValue({});
  muteDeleteOne.mockResolvedValue({ deletedCount: 1 });
  muteDeleteMany.mockResolvedValue({ deletedCount: 0 });
  postUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  postAggregate.mockResolvedValue([]);
  resolveUserSummaries.mockResolvedValue(new Map());
});

describe('GET /lanes (public)', () => {
  it('lists only the publisher\'s `tab` lanes', async () => {
    laneFind.mockReturnValue(chain([laneDoc({ displayMode: 'tab' })]));

    const res = await request(buildApp()).get('/lanes').query({ ownerId: 'author-1' });

    expect(res.status).toBe(200);
    // `mixed` has no tab of its own and `hidden` is off the showcase — a list
    // whose only purpose is drawing tabs must contain neither.
    expect(laneFind).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: 'author-1',
      displayMode: 'tab',
    });
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: LANE_ID, name: 'Dev', displayMode: 'tab' }),
    ]);
  });

  it('accepts a channel publisher', async () => {
    await request(buildApp()).get('/lanes').query({ ownerType: 'channel', ownerId: 'c1' });
    expect(laneFind).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: 'channel', ownerId: 'c1' }),
    );
  });

  it('rejects a missing owner and an unknown owner type', async () => {
    const app = buildApp();
    expect((await request(app).get('/lanes')).status).toBe(400);
    expect((await request(app).get('/lanes').query({ ownerType: 'group', ownerId: 'x' })).status).toBe(400);
  });
});

describe('GET /lanes/mine', () => {
  it('returns the caller\'s lanes with counts aggregated on read', async () => {
    laneFind.mockReturnValue(chain([laneDoc(), laneDoc({ _id: OTHER_LANE_ID, name: 'Fotos' })]));
    postAggregate.mockResolvedValue([{ _id: LANE_ID, count: 7 }]);

    const res = await request(buildApp()).get('/lanes/mine');

    expect(res.status).toBe(200);
    expect(laneFind).toHaveBeenCalledWith({ ownerType: 'user', ownerId: VIEWER_ID });
    // A lane absent from the aggregate reads as zero — there is no stored
    // counter to drift.
    expect(res.body.data.map((lane: { postCount: number }) => lane.postCount)).toEqual([7, 0]);
  });

  it('skips the aggregate entirely when the caller has no lanes', async () => {
    const res = await request(buildApp()).get('/lanes/mine');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(postAggregate).not.toHaveBeenCalled();
  });
});

describe('GET /lanes/muted', () => {
  it('resolves each publisher through the shared identity path', async () => {
    muteFind.mockReturnValue(chain([
      { laneId: LANE_ID, laneOwnerOxyUserId: OTHER_USER_ID, createdAt: new Date('2026-02-01T00:00:00.000Z') },
    ]));
    laneFind.mockReturnValue(chain([{ _id: LANE_ID, name: 'Dev', displayMode: 'tab' }]));
    resolveUserSummaries.mockResolvedValue(
      new Map([[OTHER_USER_ID, { user: { id: OTHER_USER_ID, username: 'stranger' } }]]),
    );

    const res = await request(buildApp()).get('/lanes/muted');

    expect(res.status).toBe(200);
    // Never hand-built: Oxy owns identity.
    expect(resolveUserSummaries).toHaveBeenCalledWith([OTHER_USER_ID]);
    expect(res.body.data).toEqual([
      {
        lane: { id: LANE_ID, name: 'Dev', displayMode: 'tab' },
        owner: { id: OTHER_USER_ID, username: 'stranger' },
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('drops a mute whose lane is gone rather than rendering a blank row', async () => {
    muteFind.mockReturnValue(chain([
      { laneId: LANE_ID, laneOwnerOxyUserId: OTHER_USER_ID, createdAt: new Date() },
    ]));
    laneFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/lanes/muted');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /lanes', () => {
  it('creates a lane owned by the caller, defaulting to mixed', async () => {
    laneCreate.mockResolvedValue({ toObject: () => laneDoc() });

    const res = await request(buildApp()).post('/lanes').send({ name: 'Dev' });

    expect(res.status).toBe(201);
    expect(laneCreate).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: VIEWER_ID,
      name: 'Dev',
      displayMode: 'mixed',
    });
  });

  it('answers 409 from the unique index, not from the pre-check', async () => {
    // The cap's `countDocuments` is not a lock, so two concurrent creates of one
    // name are stopped by the constraint or not at all.
    laneCount.mockResolvedValue(0);
    laneCreate.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));

    const res = await request(buildApp()).post('/lanes').send({ name: 'Dev' });

    expect(res.status).toBe(409);
  });

  it('enforces the per-publisher cap', async () => {
    laneCount.mockResolvedValue(MAX_LANES_PER_OWNER);

    const res = await request(buildApp()).post('/lanes').send({ name: 'Dev' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(String(MAX_LANES_PER_OWNER));
    expect(laneCreate).not.toHaveBeenCalled();
  });

  it('rejects a name that normalizes to nothing', async () => {
    const res = await request(buildApp()).post('/lanes').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(laneCreate).not.toHaveBeenCalled();
  });

  it('rejects a display mode outside the enum', async () => {
    const res = await request(buildApp()).post('/lanes').send({ name: 'Dev', displayMode: 'secret' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /lanes/:id', () => {
  function laneDocument(overrides: Record<string, unknown> = {}) {
    const doc = {
      ...laneDoc(overrides),
      save: vi.fn().mockResolvedValue(undefined),
      toObject: () => laneDoc(overrides),
    };
    return doc;
  }

  it('updates the caller\'s own lane', async () => {
    const doc = laneDocument();
    laneFindOne.mockResolvedValue(doc);

    const res = await request(buildApp())
      .patch(`/lanes/${LANE_ID}`)
      .send({ name: 'Notas', displayMode: 'hidden' });

    expect(res.status).toBe(200);
    expect(laneFindOne).toHaveBeenCalledWith({
      _id: LANE_ID,
      ownerType: 'user',
      ownerId: VIEWER_ID,
    });
    expect(doc.name).toBe('Notas');
    expect(doc.displayMode).toBe('hidden');
    expect(doc.save).toHaveBeenCalled();
  });

  it('answers 404 for somebody else\'s lane — the query is owner-scoped', async () => {
    laneFindOne.mockResolvedValue(null);
    const res = await request(buildApp()).patch(`/lanes/${LANE_ID}`).send({ name: 'Notas' });
    expect(res.status).toBe(404);
  });

  it('rejects an empty update and a malformed id', async () => {
    const app = buildApp();
    expect((await request(app).patch(`/lanes/${LANE_ID}`).send({})).status).toBe(400);
    expect((await request(app).patch('/lanes/mine').send({ name: 'x' })).status).toBe(400);
  });

  it('answers 409 when the rename collides', async () => {
    const doc = laneDocument();
    doc.save.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));
    laneFindOne.mockResolvedValue(doc);

    const res = await request(buildApp()).patch(`/lanes/${LANE_ID}`).send({ name: 'Fotos' });

    expect(res.status).toBe(409);
  });
});

describe('DELETE /lanes/:id', () => {
  it('unsets the posts BEFORE dropping the mutes and the lane', async () => {
    laneFindOne.mockReturnValue(chain({ _id: LANE_ID }));

    const res = await request(buildApp()).delete(`/lanes/${LANE_ID}`);

    expect(res.status).toBe(200);
    // Reversed, posts would point at a lane that no longer exists and the
    // profile exclusion query would stop matching them — so posts the owner had
    // tucked away would reappear on their profile.
    expect(writes).toEqual(['post.updateMany', 'laneMute.deleteMany', 'lane.deleteOne']);
  });

  it('$unsets rather than writing a null, which the partial index would still cover', async () => {
    laneFindOne.mockReturnValue(chain({ _id: LANE_ID }));

    await request(buildApp()).delete(`/lanes/${LANE_ID}`);

    expect(postUpdateMany).toHaveBeenCalledWith(
      { oxyUserId: VIEWER_ID, laneId: LANE_ID },
      { $unset: { laneId: '' } },
    );
  });

  it('answers 404 for somebody else\'s lane and writes nothing', async () => {
    laneFindOne.mockReturnValue(chain(null));

    const res = await request(buildApp()).delete(`/lanes/${LANE_ID}`);

    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });
});

describe('POST /lanes/:id/mute', () => {
  it('mutes another publisher\'s lane and denormalizes its owner', async () => {
    laneFindById.mockReturnValue(chain({ ownerType: 'user', ownerId: OTHER_USER_ID }));

    const res = await request(buildApp()).post(`/lanes/${LANE_ID}/mute`);

    expect(res.status).toBe(201);
    expect(muteCreate).toHaveBeenCalledWith({
      viewerOxyUserId: VIEWER_ID,
      laneId: LANE_ID,
      laneOwnerOxyUserId: OTHER_USER_ID,
    });
  });

  it('refuses to mute your OWN lane', async () => {
    laneFindById.mockReturnValue(chain({ ownerType: 'user', ownerId: VIEWER_ID }));

    const res = await request(buildApp()).post(`/lanes/${LANE_ID}/mute`);

    // It would delete your own posts from your own Following feed.
    expect(res.status).toBe(400);
    expect(muteCreate).not.toHaveBeenCalled();
  });

  it('is idempotent — a repeat succeeds and writes nothing', async () => {
    laneFindById.mockReturnValue(chain({ ownerType: 'user', ownerId: OTHER_USER_ID }));
    muteFindOne.mockReturnValue(chain({ _id: 'mute-1' }));

    const res = await request(buildApp()).post(`/lanes/${LANE_ID}/mute`);

    expect(res.status).toBe(200);
    expect(muteCreate).not.toHaveBeenCalled();
  });

  it('swallows the unique-index race, which reached the caller\'s own outcome', async () => {
    laneFindById.mockReturnValue(chain({ ownerType: 'user', ownerId: OTHER_USER_ID }));
    muteCreate.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));

    const res = await request(buildApp()).post(`/lanes/${LANE_ID}/mute`);

    expect(res.status).toBe(201);
  });

  it('enforces the mute cap', async () => {
    laneFindById.mockReturnValue(chain({ ownerType: 'user', ownerId: OTHER_USER_ID }));
    muteCount.mockResolvedValue(MAX_MUTED_LANES);

    const res = await request(buildApp()).post(`/lanes/${LANE_ID}/mute`);

    expect(res.status).toBe(400);
    expect(muteCreate).not.toHaveBeenCalled();
  });

  it('answers 404 for a lane that does not exist', async () => {
    laneFindById.mockReturnValue(chain(null));
    const res = await request(buildApp()).post(`/lanes/${LANE_ID}/mute`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /lanes/:id/mute', () => {
  it('unmutes, and answers the same success when there was nothing to unmute', async () => {
    muteDeleteOne.mockResolvedValue({ deletedCount: 0 });

    const res = await request(buildApp()).delete(`/lanes/${LANE_ID}/mute`);

    // "Not muted" is exactly the state the caller asked for.
    expect(res.status).toBe(200);
    expect(muteDeleteOne).toHaveBeenCalledWith({ viewerOxyUserId: VIEWER_ID, laneId: LANE_ID });
  });
});
