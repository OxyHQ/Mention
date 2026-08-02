import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isValidFeedDescriptor, parseFeedDescriptor, PostVisibility } from '@mention/shared-types';

/**
 * The channel feed: its descriptor, its definition, its source, and the
 * unconditional exclusion that keeps a channel post OFF every author surface.
 *
 * ## The trap this file exists for changed shape, and the reason it did is worth
 * stating
 *
 * In Mongo it was the `$or` clobber: `ChronoCursor.applyToQuery` ASSIGNED
 * `match.$or` rather than merging into it, so a filter written as a disjunction
 * worked on page one and silently stopped filtering on every page after — a
 * channel post leaking onto its author's profile only once the reader scrolled,
 * with no error anywhere. Every clause therefore had to be asserted with a LIVE
 * cursor in the query.
 *
 * That hazard does not survive the port: drizzle's `and()` COMPOSES, so a keyset
 * cannot delete a sibling predicate. The exclusion still has to be right, so it
 * is still asserted — but against ROWS across a real page boundary, which is
 * both the honest replacement and a stronger claim than "the match object still
 * has the key".
 */

import { and, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { clearPostScope, postScope, seedChannel, seedLane, seedPost } from './helpers/postFixtures';

import { channelSource, laneSource } from '../mtn/feed/engine/sources/userSources';
import { channelDefinition } from '../mtn/feed/definitions/presets';
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';
import { authorFeedSql, followedAuthorsSql } from '../utils/postAuthorship';
import { canViewChannel } from '../services/channelAccess';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

const scope = postScope('channel-feed');
const AUTHOR_ID = scope.user('author');
const DESCRIPTOR_ID = 'channel-feed-descriptor-id';

function ctx(overrides: Partial<FeedEngineContext> = {}): FeedEngineContext {
  return {
    currentUserId: scope.user('viewer'),
    followingIds: [],
    followerIds: [],
    ...overrides,
  } as FeedEngineContext;
}

const idsOf = (records: readonly CandidatePost[]): string[] => records.map((r) => r.id);

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('the channel|<id> descriptor', () => {
  it('accepts exactly one non-empty parameter', () => {
    expect(isValidFeedDescriptor(`channel|${DESCRIPTOR_ID}`)).toBe(true);
    expect(isValidFeedDescriptor('channel')).toBe(false);
    expect(isValidFeedDescriptor('channel|')).toBe(false);
    expect(isValidFeedDescriptor(`channel|${DESCRIPTOR_ID}|posts`)).toBe(false);
  });

  it('parses to the source and the id', () => {
    expect(parseFeedDescriptor(`channel|${DESCRIPTOR_ID}`)).toEqual({
      source: 'channel',
      params: [DESCRIPTOR_ID],
    });
  });

  it('resolves to the channel definition', async () => {
    const definition = await resolveDefinition(`channel|${DESCRIPTOR_ID}`);
    expect(definition?.id).toBe(`channel|${DESCRIPTOR_ID}`);
    expect(definition?.sources).toEqual([
      { module: 'channel', enabled: true, params: { channelId: DESCRIPTOR_ID } },
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
    expect(channelDefinition(DESCRIPTOR_ID).execution?.hydrateMaxDepth).toBe(1);
  });
});

describe('channelSource', () => {
  it('serves the channel\'s posts and nothing else', async () => {
    const channelId = await seedChannel(scope);
    const other = await seedChannel(scope, { handle: 'channel-feed-other' });
    const mine = await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId });
    await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId: other });
    await seedPost(scope, { oxyUserId: AUTHOR_ID });

    const served = await channelSource.gather(ctx(), { channelId }, 20);
    expect(idsOf(served)).toEqual([mine.id]);
  });

  it('excludes drafts and non-public posts, as every feed does', async () => {
    const channelId = await seedChannel(scope);
    const published = await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId });
    await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId, status: 'draft' });
    await seedPost(scope, {
      oxyUserId: AUTHOR_ID,
      channelId,
      visibility: PostVisibility.PRIVATE,
    });

    expect(idsOf(await channelSource.gather(ctx(), { channelId }, 20))).toEqual([published.id]);
  });

  it('pages on the CURSOR axis — the channelId term survives page two', async () => {
    // In Mongo the risk was a cursor DELETING this term. It cannot here, and the
    // way to prove the term is still applied on a later page is to take one.
    const channelId = await seedChannel(scope);
    const other = await seedChannel(scope, { handle: 'channel-feed-other-2' });
    const newest = await seedPost(scope, {
      oxyUserId: AUTHOR_ID,
      channelId,
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    const older = await seedPost(scope, {
      oxyUserId: AUTHOR_ID,
      channelId,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // Squarely inside the second page's window, and in a DIFFERENT channel: if
    // the cursor could clobber the channel term, this is the row that appears.
    await seedPost(scope, {
      oxyUserId: AUTHOR_ID,
      channelId: other,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const first = await channelSource.gather(ctx(), { channelId }, 1);
    expect(idsOf(first)).toEqual([newest.id]);

    const cursor = ChronoCursor.build(newest.id, newest.createdAt);
    const second = await channelSource.gather(ctx({ cursor }), { channelId }, 20);
    expect(idsOf(second)).toEqual([older.id]);
  });

  it('serves nothing for an unknown id or no id at all', async () => {
    expect(await channelSource.gather(ctx(), { channelId: 'channel-feed-nope' }, 20)).toEqual([]);
    expect(await channelSource.gather(ctx(), {}, 20)).toEqual([]);
  });

  it('honours canViewChannel — the seam a restricted level would branch in', async () => {
    const channelId = await seedChannel(scope);
    await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId });

    // The gate is consulted and answers yes for a public channel.
    expect(await channelSource.gather(ctx(), { channelId }, 20)).toHaveLength(1);

    // The negative half cannot be seeded: `visibility` has ONE value and the
    // table's CHECK refuses any other, so a "restricted channel serves nothing"
    // fixture is unrepresentable rather than merely unwritten. What is assertable
    // is that the predicate discriminates at all — it exists so that adding a
    // restricted level is widening ONE function rather than auditing every read
    // surface for the one that forgot to ask.
    expect(canViewChannel({ visibility: 'public' }, ctx().currentUserId)).toBe(true);
    expect(canViewChannel({ visibility: 'restricted' }, ctx().currentUserId)).toBe(false);
  });
});

describe('laneSource with a CHANNEL-owned lane', () => {
  it('scopes by channelId rather than by author', async () => {
    // A channel curates its page the way a user curates a profile, so a
    // channel-owned lane is a real tab — it just answers to a different gate.
    const channelId = await seedChannel(scope);
    const laneId = await seedLane(scope, {
      ownerType: 'channel',
      ownerId: channelId,
      displayMode: 'tab',
    });
    const inChannel = await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId, laneId });
    // Same lane id, no channel: reachable only if the scope term were the
    // author's rather than the channel's.
    await seedPost(scope, { oxyUserId: AUTHOR_ID, laneId });

    expect(idsOf(await laneSource.gather(ctx(), { laneId }, 20))).toEqual([inChannel.id]);
  });

  it('still refuses a lane whose displayMode is not "tab"', async () => {
    const channelId = await seedChannel(scope);
    const laneId = await seedLane(scope, {
      ownerType: 'channel',
      ownerId: channelId,
      displayMode: 'hidden',
    });
    await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId, laneId });

    expect(await laneSource.gather(ctx(), { laneId }, 20)).toEqual([]);
  });
});

/**
 * A channel post is off every author surface — the DEANONYMIZATION guard.
 *
 * The exclusion lives inside `authorFeedSql` / `followedAuthorsSql` rather than
 * at their call sites, so a new profile or following query inherits it instead
 * of having to remember it. `channel_id is null` is TOTAL: it matches every post
 * written before channels existed as well as every ordinary one, so there is no
 * backfill to do and no second clause to add.
 */
describe('the channel exclusion on the author matchers', () => {
  it('drops a channel post from BOTH matchers, and keeps the ordinary one', async () => {
    const channelId = await seedChannel(scope);
    const ordinary = await seedPost(scope, { oxyUserId: AUTHOR_ID });
    const inChannel = await seedPost(scope, { oxyUserId: AUTHOR_ID, channelId });

    const mine = inArray(posts.id, [ordinary.id, inChannel.id]);

    const authored = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(and(mine, authorFeedSql(AUTHOR_ID)));
    expect(authored.map((r) => r.id)).toEqual([ordinary.id]);

    const followed = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(and(mine, followedAuthorsSql([AUTHOR_ID])));
    expect(followed.map((r) => r.id)).toEqual([ordinary.id]);
  });

  it('keeps a post written before channels existed — the exclusion is TOTAL', async () => {
    // `channel_id` is NULL on every such row, which the predicate matches. Mongo
    // needed the note that nothing may ever store an explicit `null` (it
    // satisfied `$exists` and would have wrongly excluded the post); here `null`
    // IS "no channel", so the two states cannot diverge.
    const legacy = await seedPost(scope, { oxyUserId: AUTHOR_ID });
    const rows = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(and(inArray(posts.id, [legacy.id]), authorFeedSql(AUTHOR_ID)));
    expect(rows.map((r) => r.id)).toEqual([legacy.id]);
  });
});
