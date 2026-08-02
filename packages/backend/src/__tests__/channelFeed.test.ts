import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { isValidFeedDescriptor, parseFeedDescriptor } from '@mention/shared-types';

/**
 * The channel feed: its descriptor, its definition, its source, and the
 * unconditional exclusion that keeps a channel post OFF every author surface.
 *
 * The `$or` clobber is the trap this file exists for. `ChronoCursor.applyToQuery`
 * ASSIGNS `match.$or` rather than merging into it, so any filter written as a
 * disjunction works on page one and silently stops filtering on every page after
 * — a channel post leaking onto its author's profile only once the reader
 * scrolls, with no error anywhere. Each clause is therefore asserted with a LIVE
 * cursor in the query, not merely on a fresh match object.
 */

const findCalls: Array<Record<string, unknown>> = [];
const sortCalls: Array<Record<string, unknown>> = [];

function chainable(result: unknown[]) {
  const chain = {
    select: () => chain,
    sort: (spec: Record<string, unknown>) => {
      sortCalls.push(spec);
      return chain;
    },
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
      return chainable([]);
    }),
    aggregate: vi.fn(() => ({ option: () => Promise.resolve([]) })),
  },
}));

let channelDoc: { visibility: string } | null = null;
vi.mock('../models/Channel', () => {
  const chain = <T>(value: T) => {
    const link = { select: () => link, lean: () => Promise.resolve(value) };
    return link;
  };
  return { Channel: { findById: vi.fn(() => chain(channelDoc)) } };
});

let laneDoc: { ownerType: string; ownerId: string; displayMode: string } | null = null;
vi.mock('../models/Lane', () => {
  const chain = <T>(value: T) => {
    const link = { select: () => link, sort: () => link, lean: () => Promise.resolve(value) };
    return link;
  };
  return {
    Lane: { find: vi.fn(() => chain([])), findById: vi.fn(() => chain(laneDoc)) },
  };
});

vi.mock('../models/UserSettings', () => ({
  default: { findOne: vi.fn(() => ({ lean: () => Promise.resolve(null) })) },
}));

vi.mock('../models/Like', () => ({
  default: {
    find: vi.fn(() => ({
      sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }),
    })),
  },
}));

import { channelSource, laneSource } from '../mtn/feed/engine/sources/userSources';
import { channelDefinition } from '../mtn/feed/definitions/presets';
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';
import {
  EXCLUDE_CHANNEL_POSTS,
  buildAuthorFeedMatch,
  buildFollowedAuthorsMatch,
} from '../utils/postAuthorship';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const CHANNEL_ID = new mongoose.Types.ObjectId().toString();
const LANE_ID = new mongoose.Types.ObjectId().toString();
const AUTHOR_ID = 'author-1';

function ctx(overrides: Partial<FeedEngineContext> = {}): FeedEngineContext {
  return {
    currentUserId: 'viewer-1',
    followingIds: [],
    followerIds: [],
    ...overrides,
  } as FeedEngineContext;
}

/** A real cursor, so every assertion below runs against a PAGE TWO query. */
function liveCursor(): string {
  return ChronoCursor.build(new mongoose.Types.ObjectId().toString(), new Date('2026-01-01'));
}

beforeEach(() => {
  findCalls.length = 0;
  sortCalls.length = 0;
  channelDoc = { visibility: 'public' };
  laneDoc = null;
  vi.clearAllMocks();
});

describe('the channel|<id> descriptor', () => {
  it('accepts exactly one non-empty parameter', () => {
    expect(isValidFeedDescriptor(`channel|${CHANNEL_ID}`)).toBe(true);
    expect(isValidFeedDescriptor('channel')).toBe(false);
    expect(isValidFeedDescriptor('channel|')).toBe(false);
    expect(isValidFeedDescriptor(`channel|${CHANNEL_ID}|posts`)).toBe(false);
  });

  it('parses to the source and the id', () => {
    expect(parseFeedDescriptor(`channel|${CHANNEL_ID}`)).toEqual({
      source: 'channel',
      params: [CHANNEL_ID],
    });
  });

  it('resolves to the channel definition', async () => {
    const definition = await resolveDefinition(`channel|${CHANNEL_ID}`);
    expect(definition?.id).toBe(`channel|${CHANNEL_ID}`);
    expect(definition?.sources).toEqual([
      { module: 'channel', enabled: true, params: { channelId: CHANNEL_ID } },
    ]);
  });

  it('resolves to nothing without an id, rather than a feed of everything', async () => {
    // `'channel'` alone is not a valid descriptor, but `resolveDefinition` parses
    // whatever it is handed — so the guard has to be in the case arm too.
    expect(await resolveDefinition('channel' as `channel|${string}`)).toBeNull();
  });

  it('hydrates at depth 1 — a channel post may be a QUOTE, whose original must embed', () => {
    // Quoting a channel post is explicitly allowed (a citation is a new post on
    // the citer's timeline, not conversation inside the channel), and a quote
    // whose original is not embedded renders as a card with a hole in it.
    expect(channelDefinition(CHANNEL_ID).execution?.hydrateMaxDepth).toBe(1);
  });
});

describe('channelSource', () => {
  it('queries the literal channelId — what post_channel_chrono_v1 stores', async () => {
    await channelSource.gather(ctx(), { channelId: CHANNEL_ID }, 20);

    expect(findCalls[0]).toMatchObject({
      channelId: CHANNEL_ID,
      visibility: 'public',
      status: 'published',
    });
    // Deliberately NOT `buildAuthorFeedMatch`: its multikey `authorship` clause
    // would pull the planner onto `post_author_chrono_v1`, AND its channel
    // exclusion would empty this feed outright.
    expect(findCalls[0]).not.toHaveProperty('authorship');
  });

  it('sorts on the CURSOR axis, never _id alone', async () => {
    await channelSource.gather(ctx({ cursor: liveCursor() }), { channelId: CHANNEL_ID }, 20);
    expect(sortCalls[0]).toEqual({ createdAt: -1, _id: -1 });
  });

  it('keeps the channelId term as a FLAT conjunctive key with a live cursor', async () => {
    // `ChronoCursor.applyToQuery` ASSIGNS `$or`. A clause that lived there would
    // be deleted the moment a cursor arrived — correct page one, leaking after.
    await channelSource.gather(ctx({ cursor: liveCursor() }), { channelId: CHANNEL_ID }, 20);
    const match = findCalls[0];
    expect(match.channelId).toBe(CHANNEL_ID);
    expect(JSON.stringify(match.$or ?? [])).not.toContain('channelId');
  });

  it('serves nothing for a malformed or missing id, without a query', async () => {
    expect(await channelSource.gather(ctx(), { channelId: 'not-an-id' }, 20)).toEqual([]);
    expect(await channelSource.gather(ctx(), {}, 20)).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('serves nothing for an unknown channel', async () => {
    channelDoc = null;
    expect(await channelSource.gather(ctx(), { channelId: CHANNEL_ID }, 20)).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('honours canViewChannel — the seam a restricted level would branch in', async () => {
    channelDoc = { visibility: 'restricted' };
    expect(await channelSource.gather(ctx(), { channelId: CHANNEL_ID }, 20)).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });
});

describe('laneSource with a CHANNEL-owned lane', () => {
  it('scopes by channelId and gates on canViewChannel', async () => {
    // A channel curates its page the way a user curates a profile, so a
    // channel-owned lane is a real tab — it just answers to a different gate.
    laneDoc = { ownerType: 'channel', ownerId: CHANNEL_ID, displayMode: 'tab' };

    await laneSource.gather(ctx(), { laneId: LANE_ID }, 20);

    expect(findCalls[0]).toMatchObject({ laneId: LANE_ID, channelId: CHANNEL_ID });
    expect(findCalls[0]).not.toHaveProperty('oxyUserId');
  });

  it('serves nothing when the channel is not viewable', async () => {
    laneDoc = { ownerType: 'channel', ownerId: CHANNEL_ID, displayMode: 'tab' };
    channelDoc = { visibility: 'restricted' };

    expect(await laneSource.gather(ctx(), { laneId: LANE_ID }, 20)).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('still refuses a lane whose displayMode is not "tab"', async () => {
    laneDoc = { ownerType: 'channel', ownerId: CHANNEL_ID, displayMode: 'hidden' };
    expect(await laneSource.gather(ctx(), { laneId: LANE_ID }, 20)).toEqual([]);
  });
});

describe('EXCLUDE_CHANNEL_POSTS — a channel post is off every author surface', () => {
  it('is a flat conjunctive term matching every post written before channels existed', () => {
    expect(EXCLUDE_CHANNEL_POSTS).toEqual({ channelId: { $exists: false } });
  });

  it('rides on BOTH author-relationship matchers', () => {
    expect(buildAuthorFeedMatch(AUTHOR_ID)).toMatchObject({ channelId: { $exists: false } });
    expect(buildFollowedAuthorsMatch([AUTHOR_ID])).toMatchObject({
      channelId: { $exists: false },
    });
  });

  it('SURVIVES a live cursor — the page-two leak this rule exists for', () => {
    // The exclusion must never be written as a disjunction. Applying a real
    // cursor to a real matcher is the only way to prove it is not.
    const match: Record<string, unknown> = { ...buildAuthorFeedMatch(AUTHOR_ID) };
    ChronoCursor.applyToQuery(match, liveCursor());

    expect(match.channelId).toEqual({ $exists: false });
    // And the cursor did land, so this is a genuine page-two query rather than a
    // no-op that would pass whatever the clause looked like.
    expect(match.$or ?? match.createdAt).toBeDefined();
  });

  it('SURVIVES a live cursor on the following matcher too', () => {
    const match: Record<string, unknown> = { ...buildFollowedAuthorsMatch([AUTHOR_ID]) };
    ChronoCursor.applyToQuery(match, liveCursor());

    expect(match.channelId).toEqual({ $exists: false });
    expect(match.$or ?? match.createdAt).toBeDefined();
  });
});
