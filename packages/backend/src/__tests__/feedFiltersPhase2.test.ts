import { describe, it, expect } from 'vitest';
import { PostType } from '@mention/shared-types';
import { feedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { registerFilterModules } from '../mtn/feed/engine/filters';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

registerFilterModules();

function post(extra: Record<string, unknown> = {}): CandidatePost {
  return { _id: 'x', oxyUserId: 'a', createdAt: new Date(), ...extra };
}
function keepOf(id: string) {
  const filter = feedModuleRegistry.getFilter(id);
  if (!filter?.keep) throw new Error(`filter ${id} missing keep()`);
  return filter.keep.bind(filter);
}

describe('excludeFollowing filter', () => {
  const keep = keepOf('excludeFollowing');
  it('drops posts from followed authors', () => {
    const ctx: FeedEngineContext = { followingIds: ['a'] };
    expect(keep(post({ oxyUserId: 'a' }), ctx, {})).toBe(false);
    expect(keep(post({ oxyUserId: 'b' }), ctx, {})).toBe(true);
  });
});

describe('hasImage / hasGif / hasPoll / hasLink filters', () => {
  it('hasImage keeps image posts only', () => {
    const keep = keepOf('hasImage');
    expect(keep(post({ content: { media: [{ type: 'image' }] } }), {}, {})).toBe(true);
    expect(keep(post({ type: PostType.TEXT }), {}, {})).toBe(false);
  });
  it('hasGif keeps gif posts only', () => {
    const keep = keepOf('hasGif');
    expect(keep(post({ content: { media: [{ type: 'gif' }] } }), {}, {})).toBe(true);
    expect(keep(post({ content: { media: [{ type: 'image' }] } }), {}, {})).toBe(false);
  });
  it('hasPoll keeps poll posts', () => {
    const keep = keepOf('hasPoll');
    expect(keep(post({ type: PostType.POLL }), {}, {})).toBe(true);
    expect(keep(post({ content: { pollId: 'p1' } }), {}, {})).toBe(true);
    expect(keep(post({ type: PostType.TEXT }), {}, {})).toBe(false);
  });
  it('hasLink keeps posts with links', () => {
    const keep = keepOf('hasLink');
    expect(keep(post({ content: { text: 'see https://x.com' } }), {}, {})).toBe(true);
    expect(keep(post({ content: { sources: [{ url: 'https://y.com' }] } }), {}, {})).toBe(true);
    expect(keep(post({ content: { text: 'no links here' } }), {}, {})).toBe(false);
  });
});

describe('minEngagement filter', () => {
  const keep = keepOf('minEngagement');
  it('requires all provided thresholds', () => {
    const params = { minLikes: 5, minBoosts: 1 };
    expect(keep(post({ stats: { likesCount: 5, boostsCount: 2 } }), {}, params)).toBe(true);
    expect(keep(post({ stats: { likesCount: 4, boostsCount: 2 } }), {}, params)).toBe(false);
    expect(keep(post({ stats: { likesCount: 10, boostsCount: 0 } }), {}, params)).toBe(false);
  });
});

describe('maxLength / minLength filters', () => {
  it('maxLength drops long posts', () => {
    const keep = keepOf('maxLength');
    expect(keep(post({ content: { text: 'hello' } }), {}, { maxLength: 10 })).toBe(true);
    expect(keep(post({ content: { text: 'this text is way too long' } }), {}, { maxLength: 10 })).toBe(false);
  });
  it('minLength drops short posts', () => {
    const keep = keepOf('minLength');
    expect(keep(post({ content: { text: 'a decent length post' } }), {}, { minLength: 10 })).toBe(true);
    expect(keep(post({ content: { text: 'hi' } }), {}, { minLength: 10 })).toBe(false);
  });
});

describe('topicAllowlist / topicDenylist filters', () => {
  it('allowlist keeps only overlapping topics (no-topic excluded)', () => {
    const keep = keepOf('topicAllowlist');
    const params = { topics: ['comics'] };
    expect(keep(post({ postClassification: { topics: ['comics', 'art'] } }), {}, params)).toBe(true);
    expect(keep(post({ postClassification: { topics: ['sports'] } }), {}, params)).toBe(false);
    expect(keep(post({ postClassification: { topics: [] } }), {}, params)).toBe(false);
  });
  it('denylist drops overlapping topics (no-topic passes)', () => {
    const keep = keepOf('topicDenylist');
    const params = { topics: ['politics'] };
    expect(keep(post({ postClassification: { topics: ['politics'] } }), {}, params)).toBe(false);
    expect(keep(post({ postClassification: { topics: ['art'] } }), {}, params)).toBe(true);
    expect(keep(post({}), {}, params)).toBe(true);
  });
});

describe('localOnly / federatedOnly filters', () => {
  it('localOnly keeps posts with no federation subdoc', () => {
    const keep = keepOf('localOnly');
    expect(keep(post({}), {}, {})).toBe(true);
    expect(keep(post({ federation: { actorUri: 'https://m.social/u/x' } }), {}, {})).toBe(false);
  });
  it('federatedOnly keeps posts with a federation subdoc', () => {
    const keep = keepOf('federatedOnly');
    expect(keep(post({ federation: { actorUri: 'https://m.social/u/x' } }), {}, {})).toBe(true);
    expect(keep(post({}), {}, {})).toBe(false);
  });
});

describe('languageStrict filter', () => {
  const keep = keepOf('languageStrict');
  it('drops posts with no declared classification language', () => {
    expect(keep(post({ postClassification: { languages: ['en'] } }), {}, {})).toBe(true);
    expect(keep(post({ postClassification: { languages: [] } }), {}, {})).toBe(false);
    expect(keep(post({}), {}, {})).toBe(false);
  });
});

describe('sentimentFilter', () => {
  const keep = keepOf('sentimentFilter');
  it('keeps only requested sentiments', () => {
    const params = { sentiments: ['positive'] };
    expect(keep(post({ postClassification: { sentiment: 'positive' } }), {}, params)).toBe(true);
    expect(keep(post({ postClassification: { sentiment: 'negative' } }), {}, params)).toBe(false);
  });
});

describe('domain + instance allow/deny filters', () => {
  it('domainDenylist drops posts linking to a denied domain', () => {
    const keep = keepOf('domainDenylist');
    const params = { domains: ['spam.com'] };
    expect(keep(post({ content: { text: 'x https://spam.com/y' } }), {}, params)).toBe(false);
    expect(keep(post({ content: { text: 'x https://ok.com/y' } }), {}, params)).toBe(true);
  });
  it('instanceDenylist drops posts from a denied instance', () => {
    const keep = keepOf('instanceDenylist');
    const params = { instances: ['bad.social'] };
    expect(keep(post({ federation: { actorUri: 'https://bad.social/u/x' } }), {}, params)).toBe(false);
    expect(keep(post({ federation: { actorUri: 'https://good.social/u/x' } }), {}, params)).toBe(true);
  });
});

describe('Phase-4-blocked author filters are registered and non-destructive pre-hydration', () => {
  it('verifiedOnly passes when author verification is not resolvable pre-hydration', () => {
    const keep = keepOf('verifiedOnly');
    expect(keep(post({}), {}, {})).toBe(true); // no author.verified on lean → pass
    expect(keep(post({ author: { verified: false } }), {}, {})).toBe(false);
  });
  it('minFollowers passes when follower count is absent', () => {
    const keep = keepOf('minFollowers');
    expect(keep(post({}), {}, { minFollowers: 100 })).toBe(true);
  });
});
