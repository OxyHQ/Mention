import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { type PipelineStage } from 'mongoose';

/**
 * Finding a channel by name.
 *
 * The pipeline is asserted STAGE BY STAGE rather than through its results,
 * because the properties that matter are properties of the query Mongo is asked
 * to run: a `visibility` filter applied after the fact would produce identical
 * results today (one visibility value exists) and leak on the day a second one
 * does, and an unescaped term produces identical results for every query that
 * happens to contain no metacharacter.
 *
 * The ordering the pipeline expresses is verified against a real mongod
 * separately — a mock cannot evaluate `$switch` or `$regexMatch`.
 */

const aggregate = vi.fn();
const option = vi.fn();
const exec = vi.fn();

vi.mock('../../models/Channel', () => ({
  Channel: { aggregate: (...args: unknown[]) => aggregate(...args) },
}));

import {
  CHANNEL_SEARCH_RANK,
  MAX_CHANNEL_SEARCH_OFFSET,
  searchChannels,
} from '../../services/channelSearch';

/** A lean `Channel` row, as the aggregation hands one back. */
function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'channel-1',
    handle: 'weather',
    title: 'Weather',
    ownerOxyUserId: 'owner-1',
    visibility: 'public',
    signPosts: true,
    followerCount: 12,
    memberCount: 2,
    postCount: 40,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

/** The pipeline the last call handed to `Channel.aggregate`. */
function lastPipeline(): PipelineStage[] {
  return aggregate.mock.calls[aggregate.mock.calls.length - 1][0] as PipelineStage[];
}

function stage<T = Record<string, unknown>>(operator: string): T {
  const found = lastPipeline().find((entry) => operator in entry);
  if (!found) throw new Error(`no ${operator} stage in the pipeline`);
  return (found as Record<string, T>)[operator];
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockReturnValue({ option, exec });
  option.mockReturnValue({ exec });
  exec.mockResolvedValue([]);
});

describe('searchChannels', () => {
  it('asks Mongo for public channels only, as a match clause', async () => {
    await searchChannels('weather', { limit: 20, offset: 0 });

    expect(stage('$match')).toMatchObject({ visibility: 'public' });
  });

  it('escapes the term before it reaches a regex', async () => {
    await searchChannels('we.*ther', { limit: 20, offset: 0 });

    // EVERY regex position in the whole pipeline, not just the `$match` ones: an
    // escaped `$match` in front of an unescaped `$regexMatch` would still hand a
    // user-supplied pattern to the ranking stage.
    const patterns = [...JSON.stringify(lastPipeline()).matchAll(/"(?:\$regex|regex)":"(.*?)","/g)]
      .map((occurrence) => occurrence[1]);
    expect(patterns).toEqual(Array(5).fill('we\\\\.\\\\*ther'));

    // The one place the RAW term survives is the exact-handle tier, which is a
    // literal string equality and not a pattern — `.*` there matches the channel
    // literally handled `we.*ther`, which cannot exist, rather than every channel.
    const branches = stage<{ searchRank: { $switch: { branches: Array<{ case: unknown }> } } }>('$addFields')
      .searchRank.$switch.branches;
    expect(branches[0].case).toEqual({ $eq: ['$handleLower', 'we.*ther'] });
  });

  it('matches handle, title and description', async () => {
    await searchChannels('weather', { limit: 20, offset: 0 });

    const match = stage<{ $or: Array<Record<string, unknown>> }>('$match');
    expect(match.$or.map((clause) => Object.keys(clause)[0])).toEqual([
      'handleLower',
      'title',
      'description',
    ]);
  });

  it('ranks an exact handle above a handle substring, a title, then a description', async () => {
    await searchChannels('Weather', { limit: 20, offset: 0 });

    const branches = stage<{ searchRank: { $switch: { branches: Array<{ case: unknown; then: number }>; default: number } } }>('$addFields')
      .searchRank.$switch;

    // LITERAL values, deliberately, not `CHANNEL_SEARCH_RANK.*`: asserting the
    // constants against themselves passes however they are reordered, and a
    // `$sort` reads the emitted numbers, not the names. Verified by mutation —
    // swapping the constants leaves this the only assertion that fails.
    expect(branches.branches.map((branch) => branch.then)).toEqual([0, 1, 2]);
    expect(branches.default).toBe(3);

    // ...and the emitted numbers are what the named tiers mean, so a caller
    // reading `CHANNEL_SEARCH_RANK` is reading the real order.
    expect(CHANNEL_SEARCH_RANK.exactHandle).toBeLessThan(CHANNEL_SEARCH_RANK.handle);
    expect(CHANNEL_SEARCH_RANK.handle).toBeLessThan(CHANNEL_SEARCH_RANK.title);
    expect(CHANNEL_SEARCH_RANK.title).toBeLessThan(CHANNEL_SEARCH_RANK.description);

    // The best tier is the one whose case is the exact-handle comparison, against
    // the canonical (lowercased) handle — the only spelling `handleLower` holds.
    expect(branches.branches[0].case).toEqual({ $eq: ['$handleLower', 'weather'] });
  });

  it('sorts by rank, then followers, then _id — a total order, so offsets never repeat a row', async () => {
    await searchChannels('weather', { limit: 20, offset: 0 });

    expect(stage('$sort')).toEqual({ searchRank: 1, followerCount: -1, _id: -1 });
  });

  it('bounds the read: skip, overfetch by exactly one, and a time limit', async () => {
    await searchChannels('weather', { limit: 20, offset: 40 });

    expect(stage<number>('$skip')).toBe(40);
    expect(stage<number>('$limit')).toBe(21);
    expect(option).toHaveBeenCalledWith({ maxTimeMS: 3_000 });
  });

  it('reports hasMore from the overfetched row and does not return it', async () => {
    exec.mockResolvedValue([
      channelRow({ _id: 'a' }),
      channelRow({ _id: 'b' }),
      channelRow({ _id: 'c' }),
    ]);

    const page = await searchChannels('weather', { limit: 2, offset: 0 });

    expect(page.hasMore).toBe(true);
    expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('reports hasMore false when the page is not full', async () => {
    exec.mockResolvedValue([channelRow({ _id: 'a' })]);

    const page = await searchChannels('weather', { limit: 2, offset: 0 });

    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(1);
  });

  it('serializes through the shared channel DTO', async () => {
    exec.mockResolvedValue([channelRow({ description: 'Forecasts', avatar: 'file-1' })]);

    const page = await searchChannels('weather', { limit: 20, offset: 0 });

    expect(page.items[0]).toEqual({
      id: 'channel-1',
      handle: 'weather',
      title: 'Weather',
      description: 'Forecasts',
      avatar: 'file-1',
      ownerOxyUserId: 'owner-1',
      visibility: 'public',
      signPosts: true,
      followerCount: 12,
      memberCount: 2,
      postCount: 40,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    // A search result is nobody's own relationship to a channel — the viewer
    // state comes from the channel's own page, which loads it.
    expect(page.items[0]).not.toHaveProperty('viewerState');
  });

  it('returns nothing for a blank term without touching the database', async () => {
    const page = await searchChannels('   ', { limit: 20, offset: 0 });

    expect(page).toEqual({ items: [], hasMore: false });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('truncates an absurdly long term rather than matching on it', async () => {
    await searchChannels('a'.repeat(5_000), { limit: 20, offset: 0 });

    const match = stage<{ $or: Array<Record<string, { $regex: string }>> }>('$match');
    expect(match.$or[0].handleLower.$regex.length).toBe(300);
  });

  it('leaves out the excluded channels, in the same clause as the visibility gate', async () => {
    const excluded = new mongoose.Types.ObjectId();
    await searchChannels('weather', { limit: 20, offset: 0, excludeChannelIds: [excluded] });

    expect(stage('$match')).toMatchObject({ _id: { $nin: [excluded] } });
  });

  it('CONTROL: no exclusion clause when the caller excludes nothing', async () => {
    await searchChannels('weather', { limit: 20, offset: 0, excludeChannelIds: [] });

    expect(stage('$match')).not.toHaveProperty('_id');
  });

  it('CONTROL: the offset ceiling is the caller\'s to enforce, and the route does', async () => {
    // `searchChannels` trusts the bounds it is given — the clamp lives at the
    // HTTP boundary, where the untrusted value arrives. This asserts the constant
    // the route clamps to is exported and non-trivial, so the two cannot drift
    // apart silently.
    expect(MAX_CHANNEL_SEARCH_OFFSET).toBeGreaterThan(0);
    await searchChannels('weather', { limit: 20, offset: MAX_CHANNEL_SEARCH_OFFSET });
    expect(stage<number>('$skip')).toBe(MAX_CHANNEL_SEARCH_OFFSET);
  });
});
