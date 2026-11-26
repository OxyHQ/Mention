import { describe, expect, it } from 'bun:test';
import { PostType, PostVisibility } from '@mention/shared-types';
import { excludedCategory } from '../../services/monetization/promotion/contentExclusions';
import {
  type PromotablePost,
  type PromotionContext,
  promotionIneligibility,
} from '../../services/monetization/promotion/eligibility';

const texts = (...t: string[]) => ({ texts: t });

describe('excludedCategory: what a paid Boost can never be bought for', () => {
  it('refuses politics by the classifier topic', () => {
    expect(excludedCategory({ topics: ['news', 'politics'] })).toBe('politics');
  });

  it('refuses gambling and casinos by hashtag and by word, in several languages', () => {
    expect(excludedCategory({ hashtags: ['#Casino'] })).toBe('gambling');
    expect(excludedCategory(texts('Best online casino bonus this week'))).toBe('gambling');
    expect(excludedCategory(texts('Las mejores apuestas deportivas'))).toBe('gambling');
    expect(excludedCategory(texts('Ruleta y blackjack gratis'))).toBe('gambling');
  });

  it('refuses animal sales in either word order, and in several languages', () => {
    expect(excludedCategory(texts('Puppies for sale, vaccinated'))).toBe('animal-sales');
    expect(excludedCategory(texts('Se vende cachorro de labrador'))).toBe('animal-sales');
    expect(excludedCategory(texts('Gatitos en venta cerca de Madrid'))).toBe('animal-sales');
    expect(excludedCategory({ hashtags: ['puppiesforsale'] })).toBe('animal-sales');
  });

  it('leaves ordinary posts alone, including words that merely contain a listed one', () => {
    expect(excludedCategory(texts('My cat sleeps all day'))).toBeNull();
    expect(excludedCategory(texts('Selling my old bike, great condition'))).toBeNull();
    expect(excludedCategory(texts('A cabingo of ideas about slotted spoons'))).toBeNull();
    expect(
      excludedCategory({ topics: ['tech', 'ai'], hashtags: ['#launch'], texts: ['We shipped'] }),
    ).toBeNull();
    expect(excludedCategory({})).toBeNull();
  });
});

describe('promotionIneligibility applies it', () => {
  const BUYER = 'oxy-buyer';
  const post = (overrides: Partial<PromotablePost> = {}): PromotablePost => ({
    oxyUserId: BUYER,
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    ...overrides,
  });
  const context: PromotionContext = {
    buyerOxyUserId: BUYER,
    buyerIsProtected: false,
    authorAudienceClosed: false,
    hasOpenPromotion: false,
  };

  it('refuses an excluded category and an unclassified post, and accepts a classified clean one', () => {
    const clean = post({ classification: { status: 'baseline', topics: ['tech'] } });
    expect(promotionIneligibility(clean, context)).toEqual([]);

    expect(
      promotionIneligibility(
        post({ classification: { status: 'baseline', topics: ['politics'] } }),
        context,
      ),
    ).toEqual(['category-excluded']);
    expect(
      promotionIneligibility(
        post({ content: { variants: [{ text: 'Join our casino tonight' }] } }),
        context,
      ),
    ).toEqual(['category-excluded']);
    expect(
      promotionIneligibility(post({ classification: { status: 'pending' } }), context),
    ).toEqual(['not-classified']);
  });
});
