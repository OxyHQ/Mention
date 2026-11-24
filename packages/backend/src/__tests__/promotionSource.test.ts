/**
 * The `promotion` source, against a real database.
 *
 * What it guards is not that a promoted post is found, but everything a paid
 * post must NOT get past: content gates, a closed audience, a block, a repeat
 * within the day, a post already seen, and a promotion that is switched off,
 * unpaid, ahead of schedule, or being read by someone signed out.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import {
  activatePromotion,
  createPendingPromotion,
  promotionTier,
  recordPromotionImpression,
} from '../db/promotions/promotionRepository';
import { posts } from '../db/schema/posts';
import { postPromotions } from '../db/schema/promotions';
import { userSettings } from '../db/schema/userProfile';
import { promotionSource } from '../mtn/feed/engine/sources/promotionSource';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];
const RUN = `${process.pid}-${Date.now()}`;
const VIEWER = `promo-viewer-${RUN}`;
const tier = promotionTier('day');
if (!tier) throw new Error('the day tier must exist');
const promotionConfig = MtnConfig.promotion as { enabled: boolean };
let seq = 0;

async function promoted(options: {
  overrides?: Partial<PostRecordInput>;
  author?: string;
  activate?: boolean;
}): Promise<{ postId: string; promotionId: string; author: string }> {
  seq += 1;
  const author = options.author ?? `promo-author-${RUN}-${seq}`;
  const record = await insertPostRecord({
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'a promoted post' }] },
    ...options.overrides,
  });
  created.push(record.id);
  const promotion = await createPendingPromotion({
    postId: record.id,
    authorOxyUserId: author,
    tier,
  });
  if (!promotion) throw new Error('the fixture promotion must be created');
  if (options.activate !== false) {
    // Started an hour ago, so it is inside its window and on a schedule.
    await activatePromotion({
      id: promotion.id,
      paymentRef: `inv-${seq}`,
      now: new Date(Date.now() - 3_600_000),
      durationHours: 24,
    });
  }
  return { postId: record.id, promotionId: promotion.id, author };
}

function context(overrides: Partial<FeedEngineContext> = {}): FeedEngineContext {
  return { currentUserId: VIEWER, pageLimit: 30, ...overrides } as FeedEngineContext;
}

async function idsFor(ctx: FeedEngineContext): Promise<string[]> {
  const found = await promotionSource.gather(ctx, {}, 200);
  return found.map((candidate) => candidate.id).filter((id) => created.includes(id));
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  promotionConfig.enabled = true;
});

afterEach(async () => {
  promotionConfig.enabled = false;
  if (created.length > 0) {
    // Promotions and their ledger cascade from the post.
    await db.delete(posts).where(inArray(posts.id, created));
    created.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('promotion source', () => {
  it("puts a running promotion's post in the pool, lifted because nothing is delivered yet", async () => {
    const { postId } = await promoted({});
    const found = await promotionSource.gather(context(), {}, 200);
    const mine = found.find((candidate) => candidate.id === postId);

    expect(mine?.promotionBoost).toBe(MtnConfig.promotion.maxMultiplier);
  });

  it('returns nothing when switched off, signed out, unpaid, or past its window', async () => {
    const running = await promoted({});
    const unpaid = await promoted({ activate: false });
    const expired = await promoted({});
    await db
      .update(postPromotions)
      .set({ endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 86_400_000) })
      .where(eq(postPromotions.id, expired.promotionId));

    expect(await idsFor(context())).toEqual([running.postId]);
    expect(await idsFor(context())).not.toContain(unpaid.postId);
    expect(await idsFor(context({ currentUserId: undefined }))).toEqual([]);
    promotionConfig.enabled = false;
    expect(await idsFor(context())).toEqual([]);
  });

  it('never gets a post past a content gate or a closed audience', async () => {
    const sensitive = await promoted({
      overrides: { postClassification: { sensitive: true } as never },
    });
    const closed = await promoted({});
    await db
      .insert(userSettings)
      .values({ oxyUserId: closed.author, privacyProfileVisibility: 'private' });
    const fine = await promoted({});

    const ids = await idsFor(context());
    expect(ids).toEqual([fine.postId]);
    expect(ids).not.toContain(sensitive.postId);
    expect(ids).not.toContain(closed.postId);
    await db.delete(userSettings).where(eq(userSettings.oxyUserId, closed.author));
  });

  it('respects what this viewer has blocked, muted, seen, or already been counted for today', async () => {
    const blocked = await promoted({});
    const muted = await promoted({});
    const seen = await promoted({});
    const counted = await promoted({});
    const fresh = await promoted({});
    await recordPromotionImpression({
      promotionId: counted.promotionId,
      viewerOxyUserId: VIEWER,
      at: new Date(),
    });

    const ids = await idsFor(
      context({
        viewerPrivacy: { blockedIds: [blocked.author] } as never,
        userBehavior: { mutedAuthors: [muted.author] } as never,
        seenPostIds: [seen.postId],
      }),
    );
    expect(ids).toEqual([fresh.postId]);
  });

  it('sits out a promotion that is well ahead of its schedule', async () => {
    const ahead = await promoted({});
    const onPace = await promoted({});
    await db
      .update(postPromotions)
      .set({ deliveredImpressions: Math.floor(tier.impressions * 0.9) })
      .where(eq(postPromotions.id, ahead.promotionId));

    expect(await idsFor(context())).toEqual([onPace.postId]);
  });
});
