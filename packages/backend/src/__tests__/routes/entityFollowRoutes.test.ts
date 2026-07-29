import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OxyAuthRequest } from '@oxyhq/core/server';

/**
 * Two things this route must get right.
 *
 * 1. It accepts EXACTLY the entity kinds something reads back. `hashtag` feeds
 *    ranking (affinity + candidate sourcing) and `list` is a feed subscription
 *    (`ListSubscriptionService` + the feed controller's merge). `feed` and
 *    `topic` used to be accepted here and had NO reader anywhere: a row was
 *    written and never queried again. A custom-feed subscription is a
 *    `FeedLike` (`POST /feeds/:id/like`), so the route must reject `feed`
 *    outright rather than quietly accept a write nothing will ever honor.
 *
 * 2. Subscribing to a list obeys the SAME visibility rule as reading it. This
 *    write merges the list's members into the subscriber's feed and mutates the
 *    list's `subscriberCount`; ungated, it let any authenticated user subscribe
 *    to a stranger's private list and infer its membership from whose posts
 *    then appeared in their For You. The rule has one definition — `canViewList`
 *    in `services/listAccess` — and the tests below drive it through the route.
 */

const mockIncrementSubscriberCount = vi.fn().mockResolvedValue(undefined);
const mockDecrementSubscriberCount = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/ListSubscriptionService', () => ({
  LIST_ENTITY_TYPE: 'list',
  listSubscriptionService: {
    incrementSubscriberCount: (...args: unknown[]) => mockIncrementSubscriberCount(...args),
    decrementSubscriberCount: (...args: unknown[]) => mockDecrementSubscriberCount(...args),
  },
}));

/**
 * Only the DATABASE READ is stubbed. `canViewList` — the rule under test — runs
 * for real, so removing the gate from the route cannot be masked by a mock that
 * quietly answers "allowed".
 */
const mockLoadListVisibility = vi.fn();

vi.mock('../../services/listAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/listAccess')>();
  return {
    ...actual,
    loadListVisibility: (listId: string) => mockLoadListVisibility(listId),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EntityFollow, ENTITY_FOLLOW_TYPES } from '../../models/EntityFollow';
import { canViewList } from '../../services/listAccess';
import entityFollowRouter from '../../routes/entity-follow.routes';

const VIEWER_ID = 'viewer-1';
const OTHER_USER_ID = 'stranger-9';
const LIST_ID = '65b0c9178fcdefaf81988ffb';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    req.user = { id: VIEWER_ID };
    next();
  });
  app.use('/entity-follows', entityFollowRouter);
  return app;
}

describe('entity-follow routes — accepted entity types', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIncrementSubscriberCount.mockReset().mockResolvedValue(undefined);
    mockDecrementSubscriberCount.mockReset().mockResolvedValue(undefined);
    mockLoadListVisibility.mockReset();
  });

  it('exposes only the entity kinds that have a reader', () => {
    expect([...ENTITY_FOLLOW_TYPES]).toEqual(['hashtag', 'list']);
  });

  it.each(['feed', 'topic'])('rejects the dead entity type %s', async (entityType) => {
    const save = vi.spyOn(EntityFollow.prototype, 'save');

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType, entityId: 'entity-1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('entityType must be one of: hashtag, list');
    // The row is never written — not even optimistically.
    expect(save).not.toHaveBeenCalled();
    expect(mockIncrementSubscriberCount).not.toHaveBeenCalled();
  });

  it('rejects a feed follow on every entry point of the route', async () => {
    const app = buildApp();

    const status = await request(app)
      .get('/entity-follows/status')
      .query({ entityType: 'feed', entityId: 'feed-1' });
    expect(status.status).toBe(400);

    const list = await request(app).get('/entity-follows').query({ type: 'feed' });
    expect(list.status).toBe(400);

    const unfollow = await request(app)
      .delete('/entity-follows')
      .send({ entityType: 'feed', entityId: 'feed-1' });
    expect(unfollow.status).toBe(400);
  });

  it('still follows a hashtag', async () => {
    const save = vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'design' });

    expect(res.status).toBe(201);
    expect(save).toHaveBeenCalledTimes(1);
    // A hashtag follow is not a subscription — it must not touch list counts.
    expect(mockIncrementSubscriberCount).not.toHaveBeenCalled();
    // Nor is it a list: the visibility gate must not fire for it at all.
    expect(mockLoadListVisibility).not.toHaveBeenCalled();
  });

  it('still subscribes to a public list, and bumps its subscriber count', async () => {
    vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);
    mockLoadListVisibility.mockResolvedValue({ isPublic: true, ownerOxyUserId: OTHER_USER_ID });

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: LIST_ID });

    expect(res.status).toBe(201);
    expect(mockIncrementSubscriberCount).toHaveBeenCalledWith(LIST_ID);
  });
});

/**
 * The access-control half. Each case names the rule it guards, so a failure
 * reads as "the private-list gate is gone", not "some list test broke".
 */
describe('entity-follow routes — a list subscription obeys list visibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIncrementSubscriberCount.mockReset().mockResolvedValue(undefined);
    mockDecrementSubscriberCount.mockReset().mockResolvedValue(undefined);
    mockLoadListVisibility.mockReset();
  });

  it('refuses to subscribe a stranger to a PRIVATE list, and writes nothing', async () => {
    const save = vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);
    mockLoadListVisibility.mockResolvedValue({ isPublic: false, ownerOxyUserId: OTHER_USER_ID });

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: LIST_ID });

    expect(res.status).toBe(403);
    // The row is what leaks membership into the feed — it must never be written.
    expect(save).not.toHaveBeenCalled();
    // ...and someone else's list document must not be mutated either.
    expect(mockIncrementSubscriberCount).not.toHaveBeenCalled();
  });

  it('lets the OWNER subscribe to their own private list', async () => {
    vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);
    mockLoadListVisibility.mockResolvedValue({ isPublic: false, ownerOxyUserId: VIEWER_ID });

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: LIST_ID });

    expect(res.status).toBe(201);
    expect(mockIncrementSubscriberCount).toHaveBeenCalledWith(LIST_ID);
  });

  it('404s a list that does not exist, and writes nothing', async () => {
    const save = vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);
    mockLoadListVisibility.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: LIST_ID });

    expect(res.status).toBe(404);
    expect(save).not.toHaveBeenCalled();
    expect(mockIncrementSubscriberCount).not.toHaveBeenCalled();
  });

  it('treats a list stored without isPublic as private (fails closed)', async () => {
    const save = vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);
    mockLoadListVisibility.mockResolvedValue({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: LIST_ID });

    expect(res.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });

  it('still lets a subscriber unsubscribe from a list that has since gone private', async () => {
    const remove = vi.spyOn(EntityFollow, 'findOneAndDelete').mockResolvedValue({ _id: 'row-1' });
    // The gate deliberately does not run on DELETE, so no visibility is stubbed:
    // if one were consulted it would resolve undefined and 404, failing loudly.

    const res = await request(buildApp())
      .delete('/entity-follows')
      .send({ entityType: 'list', entityId: LIST_ID });

    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith({ userId: VIEWER_ID, entityType: 'list', entityId: LIST_ID });
    expect(mockDecrementSubscriberCount).toHaveBeenCalledWith(LIST_ID);
    expect(mockLoadListVisibility).not.toHaveBeenCalled();
  });
});

/** The rule itself, independent of any route. */
describe('canViewList', () => {
  it.each([
    ['a public list, to anyone', { isPublic: true, ownerOxyUserId: OTHER_USER_ID }, VIEWER_ID, true],
    ['a private list, to its owner', { isPublic: false, ownerOxyUserId: VIEWER_ID }, VIEWER_ID, true],
    ['a private list, to a stranger', { isPublic: false, ownerOxyUserId: OTHER_USER_ID }, VIEWER_ID, false],
    ['a private list, to nobody', { isPublic: false, ownerOxyUserId: OTHER_USER_ID }, undefined, false],
    ['a public list, to nobody', { isPublic: true, ownerOxyUserId: OTHER_USER_ID }, undefined, true],
    ['a list missing isPublic, to a stranger', { ownerOxyUserId: OTHER_USER_ID }, VIEWER_ID, false],
  ])('%s', (_label, list, viewerId, expected) => {
    expect(canViewList(list, viewerId)).toBe(expected);
  });
});

describe('entity-follow routes — write inputs are bounded', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIncrementSubscriberCount.mockReset().mockResolvedValue(undefined);
    mockLoadListVisibility.mockReset();
  });

  it('rejects a non-string entityId rather than letting an operator reach Mongo', async () => {
    const save = vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: { $ne: null } });

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an over-long entityId', async () => {
    const save = vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'x'.repeat(101) });

    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('still accepts a hashtag at the length bound', async () => {
    const save = vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'hashtag', entityId: 'x'.repeat(100) });

    expect(res.status).toBe(201);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('entity-follow routes — the entity followers endpoint is gone', () => {
  /**
   * It enumerated the followers of any entity to any authenticated caller: a
   * private list's subscriber roster, and by name everyone following a given
   * hashtag (a sensitive-interest inference, since hashtag follows appear in no
   * UI). Nothing called it. It must stay absent, not come back gated.
   */
  it.each(['list', 'hashtag'])('404s for %s', async (entityType) => {
    const res = await request(buildApp()).get(`/entity-follows/${entityType}/${LIST_ID}/followers`);
    expect(res.status).toBe(404);
  });
});
