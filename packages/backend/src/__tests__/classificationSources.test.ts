import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { PostVisibility } from '@mention/shared-types';

/**
 * Unit tests for the content-classification + discovery SOURCE modules
 * (`questions`, `news`, `instance`, `links`, `newVoices`, `topReplies`,
 * `curated`). Post.find matches are captured; Post.aggregate is configurable so
 * the two-step aggregate → fetch-by-ids sources can be asserted.
 */

const findCalls: Array<Record<string, unknown>> = [];
let findRouter: (match: Record<string, unknown>) => unknown[] = () => [];
let aggregateResult: Array<Record<string, unknown>> = [];
const aggregateCalls: unknown[][] = [];

function chainable(result: unknown[]) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    maxTimeMS: () => chain,
    lean: () => Promise.resolve(result),
  };
  return chain;
}

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn((match: Record<string, unknown>) => {
      findCalls.push(match);
      return chainable(findRouter(match));
    }),
    aggregate: vi.fn((pipeline: unknown[]) => {
      aggregateCalls.push(pipeline);
      return { option: () => Promise.resolve(aggregateResult) };
    }),
  },
}));

import {
  questionsSource,
  newsSource,
  instanceSource,
  linksSource,
  newVoicesSource,
  topRepliesSource,
  curatedSource,
} from '../mtn/feed/engine/sources/socialSources';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
function makePost(n: number, extra: Record<string, unknown> = {}) {
  return { _id: oid(n), oxyUserId: `a${n}`, createdAt: new Date(), ...extra };
}

beforeEach(() => {
  findCalls.length = 0;
  findRouter = () => [];
  aggregateResult = [];
  aggregateCalls.length = 0;
  vi.clearAllMocks();
});

describe('questions source', () => {
  it('matches posts with question intent', async () => {
    findRouter = () => [makePost(1)];
    await questionsSource.gather({}, {}, 30);
    const match = findCalls[0];
    expect(match['postClassification.intent']).toBe('question');
    expect(match.visibility).toBe(PostVisibility.PUBLIC);
  });
});

describe('news source', () => {
  it('matches news intent or news topic', async () => {
    findRouter = () => [makePost(2)];
    await newsSource.gather({}, {}, 30);
    const and = findCalls[0].$and as Array<Record<string, unknown>>;
    const or = and[0].$or as Array<Record<string, unknown>>;
    expect(or).toContainEqual({ 'postClassification.intent': 'news' });
    expect(or).toContainEqual({ 'postClassification.topics': 'news' });
  });
});

describe('instance source', () => {
  it('local domain matches posts with no federation subdoc', async () => {
    findRouter = () => [makePost(3)];
    await instanceSource.gather({}, { domain: 'local' }, 30);
    const and = findCalls[0].$and as Array<Record<string, unknown>>;
    const or = and[0].$or as Array<Record<string, unknown>>;
    expect(or).toContainEqual({ federation: { $exists: false } });
  });

  it('a remote domain matches the actor URI host via regex', async () => {
    findRouter = () => [makePost(4)];
    await instanceSource.gather({}, { domain: 'mastodon.social' }, 30);
    const match = findCalls[0];
    const re = match['federation.actorUri'] as RegExp;
    expect(re).toBeInstanceOf(RegExp);
    expect('https://mastodon.social/users/bob').toMatch(re);
    expect('https://evil.com/mastodon.social/x').not.toMatch(re);
  });

  it('returns [] with no domain', async () => {
    const posts = await instanceSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
  });
});

describe('links source', () => {
  it('matches the domain in cited sources or post text', async () => {
    findRouter = () => [makePost(5)];
    await linksSource.gather({}, { domain: 'nytimes.com' }, 30);
    const and = findCalls[0].$and as Array<Record<string, unknown>>;
    const or = and[0].$or as Array<Record<string, unknown>>;
    const keys = or.map((clause) => Object.keys(clause)[0]);
    expect(keys).toContain('content.sources.url');
    expect(keys).toContain('content.text');
    const textClause = or.find((c) => 'content.text' in c) as { 'content.text': RegExp };
    expect('read https://www.nytimes.com/2026/story here').toMatch(textClause['content.text']);
  });

  it('returns [] with no domain', async () => {
    const posts = await linksSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
  });
});

describe('newVoices source', () => {
  it('aggregates low-volume recent authors then fetches their latest post', async () => {
    aggregateResult = [{ latestPostId: oid(30) }];
    findRouter = () => [makePost(30)];
    const posts = await newVoicesSource.gather({ showSensitiveContent: false }, {}, 30);
    expect(aggregateCalls).toHaveLength(1);
    expect(posts.map((p) => String(p._id))).toEqual([oid(30).toString()]);
  });

  it('returns [] when no candidate authors', async () => {
    aggregateResult = [];
    const posts = await newVoicesSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
  });
});

describe('topReplies source', () => {
  it('ranks by engagement (aggregate) and preserves that order after fetch', async () => {
    aggregateResult = [{ _id: oid(41) }, { _id: oid(40) }];
    // Fetch returns the posts out of order; the source must restore rank order.
    findRouter = () => [makePost(40), makePost(41)];
    const posts = await topRepliesSource.gather({}, {}, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(41).toString(), oid(40).toString()]);
  });
});

describe('curated source', () => {
  it('matches curated posts', async () => {
    findRouter = () => [makePost(6, { curated: true })];
    await curatedSource.gather({}, {}, 30);
    expect(findCalls[0].curated).toBe(true);
  });
});
