import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OxyAuthRequest } from '@oxyhq/core/server';

/**
 * `/entity-follows` accepts EXACTLY the entity kinds something reads back.
 *
 * `hashtag` feeds ranking (affinity + candidate sourcing) and `list` is a feed
 * subscription (`ListSubscriptionService` + the feed controller's merge). `feed`
 * and `topic` used to be accepted here and had NO reader anywhere: a row was
 * written and never queried again. A custom-feed subscription is a `FeedLike`
 * (`POST /feeds/:id/like`), so the route must now reject `feed` outright rather
 * than quietly accept a write nothing will ever honor.
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

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EntityFollow, ENTITY_FOLLOW_TYPES } from '../../models/EntityFollow';
import entityFollowRouter from '../../routes/entity-follow.routes';

const VIEWER_ID = 'viewer-1';

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
    mockIncrementSubscriberCount.mockClear();
    mockDecrementSubscriberCount.mockClear();
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

    const followers = await request(app).get('/entity-follows/feed/feed-1/followers');
    expect(followers.status).toBe(400);

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
  });

  it('still subscribes to a list, and bumps its subscriber count', async () => {
    vi.spyOn(EntityFollow.prototype, 'save').mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/entity-follows')
      .send({ entityType: 'list', entityId: 'list-1' });

    expect(res.status).toBe(201);
    expect(mockIncrementSubscriberCount).toHaveBeenCalledWith('list-1');
  });
});
