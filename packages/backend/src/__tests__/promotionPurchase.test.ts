// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Starting a purchase: the rules of `promotionIneligibility` applied to real rows,
 * and the guarantee that nothing here activates a promotion.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { posts } from '../db/schema/posts';
import { postPromotions } from '../db/schema/promotions';
import { userSettings } from '../db/schema/userProfile';
import { startPromotionPurchase } from '../services/monetization/promotion/purchase';

let db: Database;
const created: string[] = [];
const RUN = `${process.pid}-${Date.now()}`;
const config = MtnConfig.promotion as { enabled: boolean };
let seq = 0;

async function post(overrides: Partial<PostRecordInput> = {}, author?: string) {
  seq += 1;
  const oxyUserId = author ?? `purchase-author-${RUN}-${seq}`;
  const record = await insertPostRecord({
    oxyUserId,
    authorship: [{ oxyUserId, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'purchase fixture' }] },
    ...overrides,
  });
  created.push(record.id);
  return { postId: record.id, author: oxyUserId };
}

const buy = (buyerOxyUserId: string, postId: string, tierId = 'day', buyerIsProtected = false) =>
  startPromotionPurchase({ buyerOxyUserId, buyerIsProtected, postId, tierId });

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

describe('starting a promotion purchase', () => {
  it('records a pending purchase of the tier, which activates nothing', async () => {
    const { postId, author } = await post();
    const result = await buy(author, postId, 'three-days');

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.promotion.status).toBe('pending_payment');
    expect(result.promotion.tier).toBe('three-days');
    expect(result.promotion.startsAt).toBeNull();
  });

  it('is absent while switched off, and refuses an unknown tier', async () => {
    const { postId, author } = await post();
    expect(await buy(author, postId, 'forever')).toEqual({ ok: false, reason: 'unknown-tier' });
    config.enabled = false;
    expect(await buy(author, postId)).toEqual({ ok: false, reason: 'disabled' });
  });

  it("treats someone else's post, or none, as not found", async () => {
    const { postId } = await post();
    expect(await buy('someone-else', postId)).toEqual({ ok: false, reason: 'post-not-found' });
    expect(await buy('anyone', 'no-such-post')).toEqual({ ok: false, reason: 'post-not-found' });
  });

  it('refuses the post the rules refuse, naming why', async () => {
    const repostOf = await post();
    const repost = await post({ type: PostType.REPOST, boostOf: repostOf.postId } as never);
    expect(await buy(repost.author, repost.postId)).toEqual({
      ok: false,
      reason: 'ineligible',
      ineligibility: ['not-original'],
    });

    const sensitive = await post({ postClassification: { sensitive: true } as never });
    expect(await buy(sensitive.author, sensitive.postId)).toMatchObject({
      reason: 'ineligible',
      ineligibility: ['content-restricted'],
    });

    const closed = await post();
    await db
      .insert(userSettings)
      .values({ oxyUserId: closed.author, privacyProfileVisibility: 'private' });
    expect(await buy(closed.author, closed.postId)).toMatchObject({
      ineligibility: ['audience-closed'],
    });
    await db.delete(userSettings).where(eq(userSettings.oxyUserId, closed.author));

    const minor = await post();
    expect(await buy(minor.author, minor.postId, 'day', true)).toMatchObject({
      ineligibility: ['buyer-protected'],
    });
  });

  it('allows one open purchase per post, and a new one once it is cancelled', async () => {
    const { postId, author } = await post();
    const first = await buy(author, postId);
    expect(first.ok).toBe(true);
    expect(await buy(author, postId)).toEqual({
      ok: false,
      reason: 'ineligible',
      ineligibility: ['already-promoted'],
    });

    if (first.ok) {
      await db
        .update(postPromotions)
        .set({ status: 'canceled' })
        .where(eq(postPromotions.id, first.promotion.id));
    }
    expect((await buy(author, postId)).ok).toBe(true);
  });
});
