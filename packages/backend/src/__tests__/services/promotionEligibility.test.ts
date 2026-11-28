import { describe, expect, it } from 'bun:test';
import { PostType, PostVisibility } from '@mention/shared-types';
import {
  type PromotablePost,
  type PromotionContext,
  promotionIneligibility,
} from '../../services/monetization/promotion/eligibility';

const BUYER = 'oxy-buyer';
const post = (overrides: Partial<PromotablePost> = {}): PromotablePost => ({
  oxyUserId: BUYER,
  type: PostType.TEXT,
  visibility: PostVisibility.PUBLIC,
  status: 'published',
  ...overrides,
});
const context = (overrides: Partial<PromotionContext> = {}): PromotionContext => ({
  buyerOxyUserId: BUYER,
  buyerIsProtected: false,
  authorAudienceClosed: false,
  hasOpenPromotion: false,
  ...overrides,
});

describe('promotionIneligibility', () => {
  it('lets an author promote their own original, public, published post', () => {
    expect(promotionIneligibility(post(), context())).toEqual([]);
  });

  it("refuses someone else's post, and a repost, quote or reply of anything", () => {
    expect(promotionIneligibility(post({ oxyUserId: 'someone-else' }), context())).toEqual([
      'not-owner',
    ]);
    for (const shape of [
      { type: PostType.REPOST },
      { type: PostType.QUOTE },
      { isReply: true },
      { quoteOf: 'p1' },
      { boostOf: 'p1' },
    ] satisfies Partial<PromotablePost>[]) {
      expect(promotionIneligibility(post(shape), context())).toEqual(['not-original']);
    }
  });

  it('refuses what is not public and published', () => {
    expect(promotionIneligibility(post({ visibility: 'followers_only' }), context())).toEqual([
      'not-public',
    ]);
    expect(promotionIneligibility(post({ status: 'draft' }), context())).toEqual(['not-published']);
  });

  it('never lets payment widen a content gate', () => {
    expect(
      promotionIneligibility(post({ postClassification: { sensitive: true } }), context()),
    ).toEqual(['content-restricted']);
    expect(promotionIneligibility(post({ hashtags: ['nsfw'] }), context())).toEqual([
      'content-restricted',
    ]);
    expect(promotionIneligibility(post({ federation: { spoilerText: 'cw' } }), context())).toEqual([
      'content-restricted',
    ]);
  });

  it('refuses a closed audience, a protected buyer, and a second open promotion', () => {
    expect(promotionIneligibility(post(), context({ authorAudienceClosed: true }))).toEqual([
      'audience-closed',
    ]);
    expect(promotionIneligibility(post(), context({ buyerIsProtected: true }))).toEqual([
      'buyer-protected',
    ]);
    expect(promotionIneligibility(post(), context({ hasOpenPromotion: true }))).toEqual([
      'already-promoted',
    ]);
  });

  it('reports every rule broken, in a stable order', () => {
    expect(
      promotionIneligibility(
        post({ oxyUserId: 'x', type: PostType.REPOST, status: 'draft' }),
        context({ hasOpenPromotion: true }),
      ),
    ).toEqual(['not-owner', 'not-original', 'not-published', 'already-promoted']);
  });
});
