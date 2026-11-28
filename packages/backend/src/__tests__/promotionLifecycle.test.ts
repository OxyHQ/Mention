// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Counting what a promotion delivered, and what happens when it has delivered
 * it: against a real database, because every property here is a property of the
 * ledger's primary key and of one UPDATE.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { insertPostRecord } from '../db/posts/postRepository';
import {
  activatePromotion,
  countPromotionImpressions,
  createPendingPromotion,
  pauseRunningPromotionForPost,
  promotionTier,
  recordPromotionImpression,
} from '../db/promotions/promotionRepository';
import { posts } from '../db/schema/posts';
import { postPromotions } from '../db/schema/promotions';
import {
  PromotionLifecycleJob,
  settlePromotions,
} from '../services/monetization/promotion/lifecycle';
import { recordPromotionImpressions } from '../services/monetization/promotion/impressions';

let db: Database;
const created: string[] = [];
const RUN = `${process.pid}-${Date.now()}`;
const tier = promotionTier('day');
if (!tier) throw new Error('the day tier must exist');
const config = MtnConfig.promotion as { enabled: boolean };
const HOUR = 3_600_000;
let seq = 0;

async function promoted(activeSince: Date | null, purchased?: number) {
  seq += 1;
  const author = `lifecycle-author-${RUN}-${seq}`;
  const record = await insertPostRecord({
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'lifecycle fixture' }] },
  });
  created.push(record.id);
  const row = await createPendingPromotion({ postId: record.id, authorOxyUserId: author, tier });
  if (!row) throw new Error('the fixture promotion must be created');
  if (activeSince) {
    await activatePromotion({
      id: row.id,
      paymentRef: `inv-${seq}`,
      now: activeSince,
      durationHours: 24,
    });
  }
  if (purchased !== undefined) {
    await db
      .update(postPromotions)
      .set({ purchasedImpressions: purchased })
      .where(eq(postPromotions.id, row.id));
  }
  return { postId: record.id, id: row.id, author };
}

const statusOf = async (id: string) =>
  (await db.select().from(postPromotions).where(eq(postPromotions.id, id)))[0];

beforeAll(async () => {
  db = await connectPostgres();
});
beforeEach(() => {
  config.enabled = true;
});
afterEach(async () => {
  config.enabled = false;
  if (created.length > 0) {
    await db.delete(posts).where(inArray(posts.id, created));
    created.length = 0;
  }
});
afterAll(async () => {
  await closePostgres();
});

describe('promotion impressions', () => {
  it('counts a viewer once a day, never the author, nothing outside the window, nothing when off', async () => {
    const start = new Date(Date.now() - HOUR);
    const { postId, id, author } = await promoted(start);
    const at = new Date();

    expect(
      await recordPromotionImpressions([
        { viewerOxyUserId: 'viewer-1', postId, at },
        { viewerOxyUserId: 'viewer-1', postId, at }, // the same report twice
        { viewerOxyUserId: 'viewer-2', postId, at },
        { viewerOxyUserId: author, postId, at }, // an author looking at their own post
        { viewerOxyUserId: 'viewer-3', postId, at: new Date(start.getTime() - HOUR) }, // before it began
        { viewerOxyUserId: 'viewer-4', postId: 'a-post-with-no-promotion', at },
      ]),
    ).toBe(2);
    expect(await countPromotionImpressions(id)).toBe(2);

    config.enabled = false;
    expect(await recordPromotionImpressions([{ viewerOxyUserId: 'viewer-9', postId, at }])).toBe(0);
  });
});

describe('settling promotions', () => {
  it('brings the delivered count up to the ledger and completes a promotion that delivered what was bought', async () => {
    const full = await promoted(new Date(Date.now() - HOUR), 2);
    const partial = await promoted(new Date(Date.now() - HOUR), 5);
    const at = new Date();
    for (const viewer of ['a', 'b']) {
      await recordPromotionImpression({ promotionId: full.id, viewerOxyUserId: viewer, at });
    }
    await recordPromotionImpression({ promotionId: partial.id, viewerOxyUserId: 'a', at });

    const result = await settlePromotions(new Date());

    expect(result.completed.find((row) => row.id === full.id)).toMatchObject({
      undeliveredImpressions: 0,
    });
    expect(result.completed.map((row) => row.id)).not.toContain(partial.id);
    expect((await statusOf(full.id)).status).toBe('completed');
    const running = await statusOf(partial.id);
    expect(running.status).toBe('active');
    expect(running.deliveredImpressions).toBe(1);
  });

  it('completes a promotion whose window closed, and reports what it left undelivered', async () => {
    const lapsed = await promoted(new Date(Date.now() - 30 * HOUR), 10);
    await recordPromotionImpression({
      promotionId: lapsed.id,
      viewerOxyUserId: 'a',
      at: new Date(Date.now() - 25 * HOUR),
    });

    const result = await settlePromotions(new Date());

    expect(result.completed.find((row) => row.id === lapsed.id)).toMatchObject({
      postId: lapsed.postId,
      undeliveredImpressions: 9,
    });
  });

  it('cancels an abandoned checkout, leaves a fresh one, and is idempotent', async () => {
    const abandoned = await promoted(null);
    const fresh = await promoted(null);
    await db
      .update(postPromotions)
      .set({ createdAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(postPromotions.id, abandoned.id));

    const first = await settlePromotions(new Date());
    const second = await settlePromotions(new Date());

    expect((await statusOf(abandoned.id)).status).toBe('canceled');
    expect((await statusOf(fresh.id)).status).toBe('pending_payment');
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(second.completed).toEqual([]);
    expect(second.expired).toBe(0);
  });

  it('is a no-op for the job while the feature is off', async () => {
    const job = new PromotionLifecycleJob();
    config.enabled = false;
    expect(await job.tick()).toBeNull();
    config.enabled = true;
    expect(await job.tick()).not.toBeNull();
  });
});

describe('pausing a reported promotion', () => {
  it('pauses a running promotion, and does nothing to one that is not running', async () => {
    const running = await promoted(new Date(Date.now() - HOUR));
    const pending = await promoted(null);

    expect(await pauseRunningPromotionForPost(running.postId)).toBe(true);
    expect((await statusOf(running.id)).status).toBe('paused');
    expect(await pauseRunningPromotionForPost(running.postId)).toBe(false);
    expect(await pauseRunningPromotionForPost(pending.postId)).toBe(false);
    expect((await statusOf(pending.id)).status).toBe('pending_payment');
  });
});
