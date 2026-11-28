/**
 * The backlog report against real outbox rows. It counts the whole table, so the
 * assertions are about what the rows seeded here add and the oldest they set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), setGauge: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: mocks.error },
}));
vi.mock('../../utils/metrics', () => ({ metrics: { setGauge: mocks.setGauge } }));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { engagementOutbox } from '../../db/schema/outbox';
import { posts } from '../../db/schema/posts';
import {
  ENGAGEMENT_BACKLOG_ALERT_AGE_MS,
  reportEngagementOutboxBacklog,
} from '../../services/engagement/engagementOutboxBacklog';

const EVENT_ID = 'backlog-report:event:v1';
/** Older than anything another suite leaves behind, so it is the oldest row. */
const CREATED_AT = new Date('2001-01-01T00:00:00.000Z');
let postId: string;

const gauge = (name: string): number =>
  mocks.setGauge.mock.calls.find(([metric]) => metric === name)?.[1] as number;

describe('engagement outbox backlog report', () => {
  beforeAll(async () => {
    await connectPostgres();
    const [post] = await getDb()
      .insert(posts)
      .values({ oxyUserId: 'backlog-report-owner' })
      .returning({ id: posts.id });
    postId = post.id;
    await getDb()
      .insert(engagementOutbox)
      .values({
        id: EVENT_ID,
        kind: 'post.like',
        revision: 1,
        payloadActorOxyUserId: 'backlog-report-actor',
        payloadPostId: postId,
        payloadRelationshipId: 'backlog-report',
        createdAt: CREATED_AT,
        // Never due, so no other suite's dispatcher claims it.
        availableAt: new Date('2100-01-01T00:00:00.000Z'),
        expiresAt: new Date('2100-01-01T00:00:00.000Z'),
      });
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await getDb().delete(engagementOutbox).where(eq(engagementOutbox.id, EVENT_ID));
    await getDb().delete(posts).where(eq(posts.id, postId));
    await closePostgres();
  });

  it('publishes the size and oldest age, and raises an old backlog as an error', async () => {
    const now = new Date(CREATED_AT.getTime() + ENGAGEMENT_BACKLOG_ALERT_AGE_MS);
    await reportEngagementOutboxBacklog(now);
    expect(gauge('engagement_outbox_backlog_events')).toBeGreaterThanOrEqual(1);
    expect(gauge('engagement_outbox_oldest_age_seconds')).toBe(
      ENGAGEMENT_BACKLOG_ALERT_AGE_MS / 1000,
    );
    expect(mocks.error).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while the oldest event is recent', async () => {
    await reportEngagementOutboxBacklog(new Date(CREATED_AT.getTime() + 1_000));
    expect(gauge('engagement_outbox_oldest_age_seconds')).toBe(1);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('stops counting an event once it is processed', async () => {
    await getDb()
      .update(engagementOutbox)
      .set({ status: 'processed', processedAt: new Date() })
      .where(eq(engagementOutbox.id, EVENT_ID));
    await reportEngagementOutboxBacklog(new Date(CREATED_AT.getTime() + 1_000));
    expect(gauge('engagement_outbox_oldest_age_seconds')).not.toBe(1);
  });

  it('never rejects when the read or the publish fails', async () => {
    mocks.setGauge.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    await expect(reportEngagementOutboxBacklog()).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});
