import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

/**
 * atproto feed-generator mirroring into native `feed_generators` rows.
 *
 *  - `mapGeneratorView`: `app.bsky.feed.getActorFeeds` generatorView → the
 *    normalized fields (service DID, name, description, avatar, like count),
 *    rejecting non-generator URIs and clamping over-long name/description. Pure,
 *    so it needs nothing but its input.
 *  - `syncActorFeeds`: getActorFeeds → upsert each generator on its AT-URI.
 *
 * ## What changed with the Postgres port
 *
 * The write half asserted the ARGUMENTS of a mocked `findOneAndUpdate` — the
 * filter, the `$set`, the `{ upsert: true }`. That is a statement about a call,
 * and it stayed green after the writer moved stores, while the reader
 * (`FeedGeneratorFeed.isAtprotoBacked`, already on Postgres) saw nothing: every
 * mirrored Bluesky feed served an EMPTY page, logged at info.
 *
 * So the assertions are on ROWS, and specifically on `source_network`, which is
 * the exact column the feed engine reads before it will dereference a remote
 * feed. `xrpcGet` stays mocked — it is a network call, not a store.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { feedGenerators } from '../../../db/schema/feeds';
import { loadFeedGeneratorByUri } from '../../../db/feeds/feedGeneratorRepository';
import { mapGeneratorView, syncActorFeeds } from '../../../connectors/atproto/feedgen.mapper';

/**
 * This file's private namespace. `feed_generators.uri` is globally unique and the
 * database is shared with the rest of the run, so a literal DID would collide
 * with whatever a sibling file wrote.
 */
const CREATOR_DID = 'did:plc:feedgenmappertest00000000';
const OWNER = 'oxy-feedgenmappertest-creator';

function genUri(rkey: string): string {
  return `at://${CREATOR_DID}/app.bsky.feed.generator/${rkey}`;
}

function generatorView(rkey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uri: genUri(rkey),
    did: 'did:web:feeds.example.com',
    displayName: 'Cool Feed',
    description: 'A nice feed',
    likeCount: 42,
    ...extra,
  };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await getDb().delete(feedGenerators).where(like(feedGenerators.uri, `at://${CREATOR_DID}/%`));
});

afterEach(async () => {
  await getDb().delete(feedGenerators).where(like(feedGenerators.uri, `at://${CREATOR_DID}/%`));
});

afterAll(async () => {
  await closePostgres();
});

/** Every generator this file mirrored, by AT-URI. */
async function storedGenerators() {
  return getDb()
    .select()
    .from(feedGenerators)
    .where(like(feedGenerators.uri, `at://${CREATOR_DID}/%`))
    .orderBy(feedGenerators.uri);
}

describe('mapGeneratorView', () => {
  it('maps a generator view to the normalized fields', () => {
    const generator = mapGeneratorView(generatorView('t-videogames', { avatar: 'https://cdn/a.jpg' }));
    expect(generator).toEqual({
      uri: genUri('t-videogames'),
      serviceDid: 'did:web:feeds.example.com',
      name: 'Cool Feed',
      description: 'A nice feed',
      avatar: 'https://cdn/a.jpg',
      likeCount: 42,
    });
  });

  it('clamps an over-long name and description to the display caps', () => {
    const generator = mapGeneratorView(
      generatorView('long', { displayName: 'n'.repeat(200), description: 'd'.repeat(500) }),
    );
    expect(generator?.name).toHaveLength(64);
    expect(generator?.description).toHaveLength(300);
  });

  it('rejects a non-generator URI, a missing service DID, and a missing name', () => {
    expect(mapGeneratorView({ uri: `at://${CREATOR_DID}/app.bsky.feed.post/x`, did: 'did:web:x', displayName: 'n' })).toBeNull();
    expect(mapGeneratorView(generatorView('f', { did: undefined }))).toBeNull();
    expect(mapGeneratorView(generatorView('f', { displayName: '   ' }))).toBeNull();
    expect(mapGeneratorView(undefined)).toBeNull();
  });
});

describe('syncActorFeeds', () => {
  it('writes a row the feed engine will accept as atproto-backed', async () => {
    mocks.xrpcGet.mockResolvedValue({
      feeds: [generatorView('f1'), generatorView('f2', { displayName: 'Second', avatar: 'https://cdn/a.jpg' })],
    });

    const count = await syncActorFeeds(CREATOR_DID, OWNER);

    expect(count).toBe(2);
    const rows = await storedGenerators();
    expect(rows.map((row) => row.uri)).toEqual([genUri('f1'), genUri('f2')]);
    expect(rows[0]).toMatchObject({
      name: 'Cool Feed',
      description: 'A nice feed',
      algorithm: 'atproto',
      createdBy: OWNER,
      likeCount: 42,
      // THE column. `FeedGeneratorFeed.isAtprotoBacked` serves an empty page for
      // anything else, so a row that lands without it is a feed that silently
      // returns nothing.
      sourceNetwork: 'atproto',
      sourceServiceDid: 'did:web:feeds.example.com',
    });
    expect(rows[0].sourceSyncedAt).toBeInstanceOf(Date);
    expect(rows[1]).toMatchObject({ name: 'Second', avatar: 'https://cdn/a.jpg' });
  });

  it('is idempotent — a re-sync updates the SAME row and refreshes its stamp', async () => {
    mocks.xrpcGet.mockResolvedValue({ feeds: [generatorView('f1')] });
    await syncActorFeeds(CREATOR_DID, OWNER);
    const first = await loadFeedGeneratorByUri(genUri('f1'));

    mocks.xrpcGet.mockResolvedValue({ feeds: [generatorView('f1', { displayName: 'Renamed', likeCount: 99 })] });
    await syncActorFeeds(CREATOR_DID, OWNER);

    const rows = await storedGenerators();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first?.id);
    expect(rows[0]).toMatchObject({ name: 'Renamed', likeCount: 99 });
    expect(rows[0].sourceSyncedAt?.getTime()).toBeGreaterThanOrEqual(
      first?.sourceSyncedAt?.getTime() ?? 0,
    );
  });

  it("leaves Mention's own subscriber count alone across a re-sync", async () => {
    // `subscriber_count` is not the remote service's number, so refreshing
    // mirrored metadata must not reset it.
    mocks.xrpcGet.mockResolvedValue({ feeds: [generatorView('f1')] });
    await syncActorFeeds(CREATOR_DID, OWNER);
    await getDb()
      .update(feedGenerators)
      .set({ subscriberCount: 7 })
      .where(eq(feedGenerators.uri, genUri('f1')));

    await syncActorFeeds(CREATOR_DID, OWNER);

    expect((await loadFeedGeneratorByUri(genUri('f1')))?.subscriberCount).toBe(7);
  });

  it('CLEARS a description the remote view stopped carrying', async () => {
    // Mongoose dropped `undefined` keys from an update, so a description deleted
    // upstream survived here forever. A mirror that cannot un-set a field is not
    // mirroring it.
    mocks.xrpcGet.mockResolvedValue({ feeds: [generatorView('f1')] });
    await syncActorFeeds(CREATOR_DID, OWNER);
    expect((await loadFeedGeneratorByUri(genUri('f1')))?.description).toBe('A nice feed');

    mocks.xrpcGet.mockResolvedValue({ feeds: [generatorView('f1', { description: undefined })] });
    await syncActorFeeds(CREATOR_DID, OWNER);

    expect((await loadFeedGeneratorByUri(genUri('f1')))?.description).toBeNull();
  });

  it('skips unmappable generator views', async () => {
    mocks.xrpcGet.mockResolvedValue({
      feeds: [generatorView('ok'), { uri: 'not-an-at-uri', displayName: 'x', did: 'did:web:y' }],
    });

    expect(await syncActorFeeds(CREATOR_DID, OWNER)).toBe(1);
    expect(await storedGenerators()).toHaveLength(1);
  });

  it('no-ops without a resolved Oxy owner and fails soft on a fetch error', async () => {
    expect(await syncActorFeeds(CREATOR_DID, '')).toBe(0);
    expect(mocks.xrpcGet).not.toHaveBeenCalled();

    mocks.xrpcGet.mockRejectedValue(new Error('boom'));
    expect(await syncActorFeeds(CREATOR_DID, OWNER)).toBe(0);
    expect(await storedGenerators()).toHaveLength(0);
  });
});
