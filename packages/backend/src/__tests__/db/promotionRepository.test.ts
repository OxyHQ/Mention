import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { insertPostRecord } from '../../db/posts/postRepository';
import {
  activatePromotion,
  countPromotionImpressions,
  createPendingPromotion,
  findOpenPromotionForPost,
  listDeliverablePromotions,
  promotionTier,
  recordPromotionImpression,
  transitionPromotion,
  utcDay,
} from '../../db/promotions/promotionRepository';
import { posts } from '../../db/schema/posts';
import { postPromotions } from '../../db/schema/promotions';

let db: Database;
const createdPosts: string[] = [];
const AUTHOR = `oxy-promo-author-${process.pid}-${Date.now()}`;
const tier = promotionTier('day');
if (!tier) throw new Error('the day tier must exist');

async function newPost(): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'promotion fixture', tag: 'en' }] },
  });
  createdPosts.push(record.id);
  return record.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  // Promotions and their ledger cascade from the post.
  if (createdPosts.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPosts));
    createdPosts.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('post promotions', () => {
  it('holds one open promotion per post, and frees the post when it ends', async () => {
    const postId = await newPost();
    const first = await createPendingPromotion({ postId, authorOxyUserId: AUTHOR, tier });
    expect(first?.purchasedImpressions).toBe(tier.impressions);
    expect(first?.status).toBe('pending_payment');
    expect(await createPendingPromotion({ postId, authorOxyUserId: AUTHOR, tier })).toBeNull();
    expect((await findOpenPromotionForPost(postId))?.id).toBe(first?.id);

    expect(
      await transitionPromotion({
        id: first?.id as string,
        from: ['pending_payment'],
        to: 'canceled',
      }),
    ).toBe(true);
    expect(await findOpenPromotionForPost(postId)).toBeNull();
    expect(await createPendingPromotion({ postId, authorOxyUserId: AUTHOR, tier })).not.toBeNull();
  });

  it("activates once, with a window of the tier's length, and not again", async () => {
    const postId = await newPost();
    const row = await createPendingPromotion({ postId, authorOxyUserId: AUTHOR, tier });
    const now = new Date('2026-12-01T10:00:00Z');
    const input = { id: row?.id as string, paymentRef: 'inv_1', now, durationHours: 24 };

    expect(await activatePromotion(input)).toBe(true);
    expect(await activatePromotion(input)).toBe(false);
    const open = await findOpenPromotionForPost(postId);
    expect(open?.status).toBe('active');
    expect(open?.endsAt?.toISOString()).toBe('2026-12-02T10:00:00.000Z');
  });

  it('does not move a promotion backwards from a status it was not in', async () => {
    const postId = await newPost();
    const row = await createPendingPromotion({ postId, authorOxyUserId: AUTHOR, tier });
    await transitionPromotion({ id: row?.id as string, from: ['pending_payment'], to: 'canceled' });

    expect(
      await transitionPromotion({ id: row?.id as string, from: ['active'], to: 'paused' }),
    ).toBe(false);
  });

  it('counts a viewer once per UTC day, and again the next day', async () => {
    const postId = await newPost();
    const row = await createPendingPromotion({ postId, authorOxyUserId: AUTHOR, tier });
    const promotionId = row?.id as string;
    const monday = new Date('2026-12-01T09:00:00Z');

    expect(
      await recordPromotionImpression({ promotionId, viewerOxyUserId: 'v1', at: monday }),
    ).toBe(true);
    expect(
      await recordPromotionImpression({
        promotionId,
        viewerOxyUserId: 'v1',
        at: new Date('2026-12-01T23:59:00Z'),
      }),
    ).toBe(false);
    expect(
      await recordPromotionImpression({ promotionId, viewerOxyUserId: 'v2', at: monday }),
    ).toBe(true);
    expect(
      await recordPromotionImpression({
        promotionId,
        viewerOxyUserId: 'v1',
        at: new Date('2026-12-02T00:01:00Z'),
      }),
    ).toBe(true);
    expect(await countPromotionImpressions(promotionId)).toBe(3);
    expect(utcDay(monday)).toBe('2026-12-01');
  });

  it('lists only promotions that are running and have views left', async () => {
    const running = await newPost();
    const exhausted = await newPost();
    const pending = await newPost();
    const now = new Date('2026-12-01T10:00:00Z');
    const make = async (postId: string, activate: boolean) => {
      const row = await createPendingPromotion({ postId, authorOxyUserId: AUTHOR, tier });
      if (activate) {
        await activatePromotion({
          id: row?.id as string,
          paymentRef: 'inv',
          now,
          durationHours: 24,
        });
      }
      return row?.id as string;
    };
    const runningId = await make(running, true);
    const exhaustedId = await make(exhausted, true);
    await make(pending, false);
    await db
      .update(postPromotions)
      .set({ deliveredImpressions: tier.impressions })
      .where(eq(postPromotions.id, exhaustedId));

    const ids = (await listDeliverablePromotions(new Date('2026-12-01T12:00:00Z'), 100)).map(
      (row) => row.id,
    );
    expect(ids).toContain(runningId);
    expect(ids).not.toContain(exhaustedId);
    expect(
      await listDeliverablePromotions(new Date('2026-12-05T00:00:00Z'), 100),
    ).not.toContainEqual(expect.objectContaining({ id: runningId }));
  });
});
