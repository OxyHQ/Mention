/**
 * Finding a channel by name, against real rows.
 *
 * The old suite asserted the Mongo pipeline STAGE BY STAGE and said in its own
 * docblock that the ordering "is verified against a real mongod separately — a
 * mock cannot evaluate `$switch` or `$regexMatch`". It never was. The port makes
 * that unnecessary: every ranking case below is decided by Postgres evaluating
 * the real `case` expression, so the relevance order is a fact about the query
 * rather than about the shape of an object handed to a mock.
 *
 * Each ranking fixture is arranged so **`follower_count` would produce the
 * OPPOSITE order**. Without that the tiers and the tiebreak are indistinguishable
 * and every case passes on the wrong reason.
 *
 * ## Two properties are deliberately not covered, and neither can be today
 *
 *  - **`visibility` is a WHERE clause rather than a post-filter.**
 *    `CHANNEL_VISIBILITIES` has one member and `channels_visibility_check`
 *    refuses anything else, so no fixture can produce a row the clause would
 *    exclude. The reason the clause exists is the day a second tier is added; a
 *    case seeded then is what will make it observable.
 *  - **`statement_timeout`.** It bounds a query slow enough to hit it, and this
 *    table holds tens of rows.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { MAX_CHANNEL_DESCRIPTION_LENGTH } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { channels } from '../../db/schema/channels';
import {
  CHANNEL_SEARCH_RANK,
  MAX_CHANNEL_SEARCH_OFFSET,
  searchChannels,
} from '../../services/channelSearch';

const run = randomUUID().replace(/-/g, '').slice(0, 8);
const createdChannelIds: string[] = [];
let handleSeq = 0;

/**
 * A term no other suite's channel can contain, so a global search over a shared
 * table still answers about this file's rows only.
 */
function uniqueTerm(): string {
  return `t${run}${(handleSeq += 1).toString().padStart(3, '0')}`;
}

async function seedChannel(
  overrides: Partial<typeof channels.$inferInsert> = {},
): Promise<typeof channels.$inferSelect> {
  const handle = overrides.handle ?? `c${run}${(handleSeq += 1).toString().padStart(3, '0')}`;
  const [row] = await getDb()
    .insert(channels)
    .values({
      handle,
      handleLower: handle.toLowerCase(),
      title: 'a channel',
      ownerOxyUserId: `owner-${run}`,
      ...overrides,
    })
    .returning();
  createdChannelIds.push(row.id);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  if (createdChannelIds.length > 0) {
    await getDb().delete(channels).where(inArray(channels.id, createdChannelIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('searchChannels — what it matches', () => {
  it('matches the handle, the title and the description', async () => {
    const term = uniqueTerm();
    const byHandle = await seedChannel({ handle: `x${term}` });
    const byTitle = await seedChannel({ title: `About ${term}` });
    const byDescription = await seedChannel({ description: `Covering ${term} daily` });

    const page = await searchChannels(term, { limit: 20, offset: 0 });

    expect(page.items.map((item) => item.id).sort()).toEqual(
      [byHandle.id, byTitle.id, byDescription.id].sort(),
    );
  });

  it('is case-insensitive on all three fields', async () => {
    const term = uniqueTerm();
    const channel = await seedChannel({ title: `About ${term.toUpperCase()}` });

    const page = await searchChannels(term.toUpperCase(), { limit: 20, offset: 0 });

    expect(page.items.map((item) => item.id)).toEqual([channel.id]);
  });

  it('escapes the LIKE wildcards rather than letting them match everything', async () => {
    // The Mongo version escaped REGEX metacharacters; the alphabet changed with
    // the port and `%` is the one that matters — unescaped it is a
    // match-everything wildcard, which is the same hole in a different spelling.
    const channel = await seedChannel({ title: `About ${uniqueTerm()}` });

    for (const wildcard of ['%', '_', '%%%']) {
      const page = await searchChannels(wildcard, { limit: 50, offset: 0 });
      expect(page.items.map((item) => item.id)).not.toContain(channel.id);
    }
  });

  it('finds a literal wildcard when a channel really contains one', async () => {
    // The control for the case above: escaping must make `%` searchable, not
    // unsearchable.
    const term = uniqueTerm();
    const channel = await seedChannel({ title: `100% ${term}` });

    const page = await searchChannels(`100% ${term}`, { limit: 20, offset: 0 });

    expect(page.items.map((item) => item.id)).toEqual([channel.id]);
  });

  it('returns nothing for a blank term — a search box nobody typed in asked nothing', async () => {
    await seedChannel({ title: `About ${uniqueTerm()}` });

    expect(await searchChannels('', { limit: 20, offset: 0 })).toEqual({
      items: [],
      hasMore: false,
    });
    expect(await searchChannels('   ', { limit: 20, offset: 0 })).toEqual({
      items: [],
      hasMore: false,
    });
  });

  it('truncates a term longer than the longest field it could match', async () => {
    // Discriminating BECAUSE the description is exactly as long as the cap: the
    // term matches once its tail is cut and matches nothing if it is not, so the
    // truncation is observable in the RESULT rather than only in the work saved.
    const term = uniqueTerm();
    const description = term.padEnd(MAX_CHANNEL_DESCRIPTION_LENGTH, 'a');
    const channel = await seedChannel({ description });

    const page = await searchChannels(description + 'z'.repeat(100), { limit: 20, offset: 0 });

    expect(description).toHaveLength(MAX_CHANNEL_DESCRIPTION_LENGTH);
    expect(page.items.map((item) => item.id)).toEqual([channel.id]);
  });
});

describe('searchChannels — relevance', () => {
  /**
   * One channel per tier, with `follower_count` DESCENDING in the opposite
   * direction — so an implementation that ranked by followers alone would return
   * the exact reverse of the expected order.
   */
  async function seedOneOfEachTier(term: string) {
    const exactHandle = await seedChannel({ handle: term, followerCount: 1 });
    const handleSubstring = await seedChannel({ handle: `x${term}y`, followerCount: 2 });
    const title = await seedChannel({ title: `About ${term}`, followerCount: 3 });
    const description = await seedChannel({
      description: `Covering ${term}`,
      followerCount: 4,
    });
    return { exactHandle, handleSubstring, title, description };
  }

  it('ranks an exact handle above a handle substring, a title, then a description', async () => {
    const term = uniqueTerm();
    const tiers = await seedOneOfEachTier(term);

    const page = await searchChannels(term, { limit: 20, offset: 0 });

    expect(page.items.map((item) => item.id)).toEqual([
      tiers.exactHandle.id,
      tiers.handleSubstring.id,
      tiers.title.id,
      tiers.description.id,
    ]);
  });

  it('the tiers are the ones the exported constant names', async () => {
    // The constant is what a caller reads to reason about the order; a rank
    // table that stopped agreeing with the query would be a silent lie.
    expect(CHANNEL_SEARCH_RANK.exactHandle).toBeLessThan(CHANNEL_SEARCH_RANK.handle);
    expect(CHANNEL_SEARCH_RANK.handle).toBeLessThan(CHANNEL_SEARCH_RANK.title);
    expect(CHANNEL_SEARCH_RANK.title).toBeLessThan(CHANNEL_SEARCH_RANK.description);
  });

  it('breaks a tier tie by follower count', async () => {
    const term = uniqueTerm();
    const popular = await seedChannel({ title: `About ${term}`, followerCount: 90 });
    const quiet = await seedChannel({ title: `Also about ${term}`, followerCount: 5 });

    const page = await searchChannels(term, { limit: 20, offset: 0 });

    expect(page.items.map((item) => item.id)).toEqual([popular.id, quiet.id]);
  });

  it('breaks a follower tie by id, so the order is TOTAL and an offset page never repeats a row', async () => {
    const term = uniqueTerm();
    const first = await seedChannel({ title: `About ${term}`, followerCount: 7 });
    const second = await seedChannel({ title: `Also ${term}`, followerCount: 7 });

    const all = await searchChannels(term, { limit: 20, offset: 0 });
    const pageOne = await searchChannels(term, { limit: 1, offset: 0 });
    const pageTwo = await searchChannels(term, { limit: 1, offset: 1 });

    // Descending id, which is what the query orders by — the values are `text`,
    // so this is a stable collation order rather than a chronological one.
    const expected = [first.id, second.id].sort().reverse();
    expect(all.items.map((item) => item.id)).toEqual(expected);
    expect(pageOne.items.map((item) => item.id)).toEqual([expected[0]]);
    expect(pageTwo.items.map((item) => item.id)).toEqual([expected[1]]);
  });
});

describe('searchChannels — paging', () => {
  it('overfetches by exactly one and does not return the extra row', async () => {
    const term = uniqueTerm();
    await seedChannel({ title: `About ${term}`, followerCount: 3 });
    await seedChannel({ title: `About ${term} too`, followerCount: 2 });

    const page = await searchChannels(term, { limit: 1, offset: 0 });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('reports hasMore false when the page is not full', async () => {
    const term = uniqueTerm();
    await seedChannel({ title: `About ${term}` });

    const page = await searchChannels(term, { limit: 20, offset: 0 });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('reports hasMore false when the page is EXACTLY full', async () => {
    const term = uniqueTerm();
    await seedChannel({ title: `About ${term}`, followerCount: 2 });
    await seedChannel({ title: `Also ${term}`, followerCount: 1 });

    const page = await searchChannels(term, { limit: 2, offset: 0 });

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it('offsets into the ranked order', async () => {
    const term = uniqueTerm();
    await seedChannel({ title: `About ${term}`, followerCount: 3 });
    const middle = await seedChannel({ title: `Also ${term}`, followerCount: 2 });
    await seedChannel({ title: `Third ${term}`, followerCount: 1 });

    const page = await searchChannels(term, { limit: 1, offset: 1 });

    expect(page.items.map((item) => item.id)).toEqual([middle.id]);
  });

  it('exports the offset ceiling the route clamps to', async () => {
    // The ceiling is the CALLER's to enforce and `routes/channels.routes.ts`
    // does; this module publishes the number so there is only one of it.
    expect(MAX_CHANNEL_SEARCH_OFFSET).toBeGreaterThan(0);
  });
});

describe('searchChannels — exclusions', () => {
  it('leaves out the excluded channels', async () => {
    const term = uniqueTerm();
    const excluded = await seedChannel({ title: `About ${term}`, followerCount: 2 });
    const kept = await seedChannel({ title: `Also ${term}`, followerCount: 1 });

    const page = await searchChannels(term, {
      limit: 20,
      offset: 0,
      excludeChannelIds: [excluded.id],
    });

    expect(page.items.map((item) => item.id)).toEqual([kept.id]);
  });

  it('CONTROL: excludes nothing when the caller excludes nothing', async () => {
    const term = uniqueTerm();
    const channel = await seedChannel({ title: `About ${term}` });

    for (const excludeChannelIds of [undefined, []]) {
      const page = await searchChannels(term, { limit: 20, offset: 0, excludeChannelIds });
      expect(page.items.map((item) => item.id)).toEqual([channel.id]);
    }
  });
});

describe('searchChannels — the DTO', () => {
  it('serializes through the shared channel DTO', async () => {
    const term = uniqueTerm();
    const channel = await seedChannel({
      title: `About ${term}`,
      description: 'A description',
      signPosts: true,
      followerCount: 12,
      memberCount: 2,
      postCount: 40,
    });

    const [item] = (await searchChannels(term, { limit: 20, offset: 0 })).items;

    expect(item).toEqual({
      id: channel.id,
      handle: channel.handle,
      title: `About ${term}`,
      description: 'A description',
      ownerOxyUserId: `owner-${run}`,
      visibility: 'public',
      signPosts: true,
      followerCount: 12,
      memberCount: 2,
      postCount: 40,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
    });
  });

  it('omits an absent description rather than sending null', async () => {
    // Postgres answers `null` where Mongo left the key out, and
    // `Channel.description` is `string | undefined`.
    const term = uniqueTerm();
    await seedChannel({ title: `About ${term}` });

    const [item] = (await searchChannels(term, { limit: 20, offset: 0 })).items;

    expect(item).not.toHaveProperty('description');
    expect(item).not.toHaveProperty('avatar');
    expect(item).not.toHaveProperty('banner');
  });

  it('never carries a viewerState — search is reader-agnostic', async () => {
    const term = uniqueTerm();
    await seedChannel({ title: `About ${term}` });

    const [item] = (await searchChannels(term, { limit: 20, offset: 0 })).items;

    expect(item).not.toHaveProperty('viewerState');
  });
});
