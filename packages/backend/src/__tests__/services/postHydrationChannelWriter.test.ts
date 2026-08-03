import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * DISCLOSING THE HUMAN BEHIND A CHANNEL POST.
 *
 * A channel is an Oxy account and AUTHORS its own posts; the person who wrote one
 * is recorded on `Post.writtenByOxyUserId`, deliberately outside `authorship`.
 * `UserSettings.channel.signPosts` decides whether that person is NAMED, and the
 * naming reuses the collaborative byline: the writer becomes a second entry in
 * `authors[]` (`role: 'writer'`), which is what makes the existing multi-author
 * header draw both.
 *
 * Everything below exists to pin the guard, because the failure it prevents is
 * silent and irreversible: a writer named without their channel opting in.
 *
 * The guard is deliberately over-determined — the account must BE a channel, the
 * settings row must say `signPosts === true`, and the post must carry a writer —
 * so each clause gets a case that ONLY it can fail, and each of those cases is a
 * mutation test: break that clause and exactly one assertion goes red.
 *
 * The `=== true` read gets the fixture the ecosystem rule asks for (a truthy
 * NON-boolean), because `true` / `false` / absent cannot tell a strict read from
 * `Boolean(...)` — every one of them agrees.
 */

const POST_ID = '650000000000000000000031';
const CHANNEL_ID = 'oxy-channel';
const WRITER_ID = 'oxy-writer';
const PERSON_ID = 'oxy-person';
/** A SECOND channel, so a page can hold one that signs and one that does not. */
const QUIET_CHANNEL_ID = 'oxy-channel-quiet';
const QUIET_WRITER_ID = 'oxy-writer-quiet';

const { getUserById, getUsersByIds, cacheStore, userSettingsSelect } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  /**
   * Stages the rows a `select … from user_settings` resolves to, and counts them.
   *
   * The rows are in the SELECT'S ALIAS shape (`signPosts`), not the column's
   * (`channel_account_sign_posts`), because that is what the query hands the
   * code under test. This fake therefore says nothing about which COLUMN the
   * alias reads — that is round-tripped against a real database in
   * `__tests__/channelAccountSchema.test.ts`, and the division is deliberate:
   * this file is about the disclosure DECISION, that one about the storage.
   */
  userSettingsSelect: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById,
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

/**
 * The whole Postgres surface hydration touches, faked at ONE seam.
 *
 * `getDb()` returns a thenable query builder whose every chaining method returns
 * itself, so any `select(...).from(X).where(...)` awaits to `[]` — except a read
 * `from(userSettings)`, which resolves whatever the case under test staged.
 * Routing on the TABLE rather than on the query shape is what keeps the two
 * `user_settings` readers (the viewer-context privacy read and the
 * channel-signing read) distinguishable from every other table without the fake
 * having to model any of them.
 *
 * `userSettingsSelect` therefore counts exactly the `user_settings` reads, which
 * is what the batching cases below assert on.
 */
vi.mock('../../db/postgres', async () => {
  const { getTableName } = await import('drizzle-orm');
  const builder = () => {
    const q: Record<string, unknown> = {};
    let rows: unknown[] = [];
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'offset', 'groupBy']) {
      q[m] = (arg?: unknown) => {
        // Routed on the TABLE, read through drizzle's own `getTableName` rather
        // than a hand-rolled symbol lookup, so the fake cannot drift from what
        // the query builder actually sees.
        if (m === 'from' && arg && getTableName(arg as never) === 'user_settings') {
          rows = userSettingsSelect() as unknown[];
        }
        return q;
      };
    }
    q.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return q;
  };
  const db = {
    select: () => builder(),
    selectDistinct: () => builder(),
  };
  return { getDb: () => db, connectPostgres: async () => db, closePostgres: async () => {} };
});

vi.mock('../../db/posts/postRepository', () => ({
  loadPostRecords: async () => [],
  findPostRecords: async () => [],
  findBoostedPostIds: async () => new Map(),
  countQuotesOf: async () => new Map(),
  CHRONO_DESC: [],
}));

vi.mock('../../db/federation/actorRepository', () => ({
  findActorsByOxyUserIds: async () => [],
  findActorsByUris: async () => [],
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import { PostHydrationService } from '../../services/PostHydrationService';

/** A post published BY `authorId`, written by `writerId` when one is given. */
function postRow(authorId: string, writerId?: string) {
  return {
    _id: POST_ID,
    oxyUserId: authorId,
    ...(writerId ? { writtenByOxyUserId: writerId } : {}),
    authorship: [{ oxyUserId: authorId, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { variants: [{ tag: 'en', source: 'author', text: 'a channel note' }] },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, savesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2026-02-01T00:00:00Z') },
    createdAt: new Date('2026-02-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

const CHANNEL_ACCOUNT = {
  id: CHANNEL_ID,
  username: 'thechannel',
  name: { displayName: 'The Channel' },
  kind: 'channel',
  verified: false,
};
const WRITER_ACCOUNT = {
  id: WRITER_ID,
  username: 'thewriter',
  name: { displayName: 'The Writer' },
  kind: 'personal',
  verified: false,
};
const PERSON_ACCOUNT = {
  id: PERSON_ID,
  username: 'aperson',
  name: { displayName: 'A Person' },
  kind: 'personal',
  verified: false,
};
const QUIET_CHANNEL_ACCOUNT = {
  id: QUIET_CHANNEL_ID,
  username: 'quietchannel',
  name: { displayName: 'Quiet Channel' },
  kind: 'channel',
  verified: false,
};
const QUIET_WRITER_ACCOUNT = {
  id: QUIET_WRITER_ID,
  username: 'quietwriter',
  name: { displayName: 'Quiet Writer' },
  kind: 'personal',
  verified: false,
};

/** Ids the identity batch was actually asked to resolve, flattened across calls. */
function requestedIds(): string[] {
  return getUsersByIds.mock.calls.flatMap((call) => (call[0] as string[]) ?? []);
}

describe('PostHydrationService — the channel writer byline', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    userSettingsSelect.mockReset();

    userSettingsSelect.mockReturnValue([]);
    getUserById.mockResolvedValue(null);
    getUsersByIds.mockImplementation(async (ids: string[]) =>
      [
        CHANNEL_ACCOUNT,
        WRITER_ACCOUNT,
        PERSON_ACCOUNT,
        QUIET_CHANNEL_ACCOUNT,
        QUIET_WRITER_ACCOUNT,
      ].filter((u) => ids.includes(u.id)),
    );

    service = new PostHydrationService();
  });

  it('names the writer as a SECOND author when the channel signs its posts', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: CHANNEL_ID, signPosts: true }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => [a.id, a.role])).toEqual([
      [CHANNEL_ID, 'owner'],
      [WRITER_ID, 'writer'],
    ]);
    // Two authors is exactly what makes the existing collaborative header draw
    // an avatar cluster and an "A and B" name row instead of a solo byline.
    expect(hydrated.authors).toHaveLength(2);
    // The channel is the signature: it stays the primary author.
    expect(hydrated.user.id).toBe(CHANNEL_ID);
    expect(hydrated.user.name?.displayName).toBe('The Channel');
    // Canonical Oxy identity, passed through — never a flat handle/avatarUrl.
    expect(hydrated.authors[1].username).toBe('thewriter');
    expect(hydrated.authors[1].name?.displayName).toBe('The Writer');
  });

  it('discloses NOBODY when the channel has not opted in', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: CHANNEL_ID, signPosts: false }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
    // Not merely unrendered: the writer was never even resolved, so no identity
    // of theirs was fetched, cached or held anywhere in this request.
    expect(requestedIds()).not.toContain(WRITER_ID);
  });

  it('discloses NOBODY when the channel has no settings row at all', async () => {
    userSettingsSelect.mockReturnValue([]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
    expect(requestedIds()).not.toContain(WRITER_ID);
  });

  /**
   * The fixture that tells `signPosts === true` from `Boolean(signPosts)`.
   *
   * Every other case here is `true`, `false` or absent, and a loose read agrees
   * with a strict one on all three — so without a truthy NON-boolean, dropping
   * the `=== true` leaves the whole suite green. This value is the shape a stray
   * write or a hand-edited document produces, and it must NOT disclose.
   */
  it('refuses a truthy non-boolean signPosts', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: CHANNEL_ID, signPosts: 'false' }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
    expect(requestedIds()).not.toContain(WRITER_ID);
  });

  it('discloses NOBODY when the settings lookup fails — it fails CLOSED', async () => {
    userSettingsSelect.mockImplementation(() => {
      throw new Error('postgres is down');
    });

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
    expect(requestedIds()).not.toContain(WRITER_ID);
  });

  /**
   * The `kind` clause on its own. A settings row saying `signPosts: true` under a
   * PERSONAL account is not a channel disclosing its writer — it is a row that
   * should not exist — and hydration must not treat it as consent to name
   * somebody on a person's own post.
   */
  it('discloses nobody when the author is not a channel account', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: PERSON_ID, signPosts: true }]);

    const [hydrated] = await service.hydratePosts([postRow(PERSON_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([PERSON_ID]);
  });

  /**
   * The clause NO single-channel fixture can reach.
   *
   * Every case above puts one channel on the page, so the signing set is either
   * empty (and the whole lookup short-circuits) or contains the only author
   * present — and under both, a per-post membership check and no check at all
   * agree. Mutation-tested: dropping `signingChannelIds.has(...)` from the
   * id-collection pass leaves that suite entirely green. A page holding one
   * channel that signs BESIDE one that does not is the shape that tells them
   * apart, and it is also the ordinary shape of a real feed.
   */
  it('discloses only the signing channel when a page holds both', async () => {
    userSettingsSelect.mockReturnValue([
      { oxyUserId: CHANNEL_ID, signPosts: true },
      { oxyUserId: QUIET_CHANNEL_ID, signPosts: false },
    ]);

    const hydrated = await service.hydratePosts(
      [
        { ...postRow(CHANNEL_ID, WRITER_ID), _id: '650000000000000000000051' },
        { ...postRow(QUIET_CHANNEL_ID, QUIET_WRITER_ID), _id: '650000000000000000000052' },
      ],
      { maxDepth: 0 },
    );

    const byAuthor = new Map(hydrated.map((post) => [post.user.id, post.authors.map((a) => a.id)]));
    expect(byAuthor.get(CHANNEL_ID)).toEqual([CHANNEL_ID, WRITER_ID]);
    expect(byAuthor.get(QUIET_CHANNEL_ID)).toEqual([QUIET_CHANNEL_ID]);
    // The quiet channel's writer is not merely unnamed — they are never fetched,
    // even though the very same batch resolved the other channel's writer.
    expect(requestedIds()).toContain(WRITER_ID);
    expect(requestedIds()).not.toContain(QUIET_WRITER_ID);
  });

  /**
   * The byline's own signing check, which the id gate normally hides.
   *
   * Withholding the id from the identity batch is what usually makes disclosure
   * impossible — so in every fixture above, the byline check is unfalsifiable:
   * mutate it away and nothing moves, because `userMap` has no writer to name.
   * That stops being true the moment the writer is in the batch for some OTHER
   * reason, and the most ordinary reason there is: they also post under their own
   * name, and one of those posts is on this page.
   *
   * So this is the case where the byline check alone stands between a channel
   * that did not opt in and the name of the person who writes for it.
   */
  it('does not name a non-signing channel\'s writer even when they are already resolved', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: QUIET_CHANNEL_ID, signPosts: false }]);

    const hydrated = await service.hydratePosts(
      [
        // The writer's own post, under their own name — this is what puts them
        // in the identity batch.
        { ...postRow(QUIET_WRITER_ID), _id: '650000000000000000000061' },
        { ...postRow(QUIET_CHANNEL_ID, QUIET_WRITER_ID), _id: '650000000000000000000062' },
      ],
      { maxDepth: 0 },
    );

    const channelPost = hydrated.find((post) => post.user.id === QUIET_CHANNEL_ID);
    expect(channelPost).toBeDefined();
    expect(channelPost?.authors.map((a) => a.id)).toEqual([QUIET_CHANNEL_ID]);
    // Vacuity floor: the writer really was resolved in this batch, so the
    // assertion above is about the byline refusing to name them and not about
    // an identity that was simply unavailable.
    expect(requestedIds()).toContain(QUIET_WRITER_ID);
    expect(hydrated.find((post) => post.user.id === QUIET_WRITER_ID)?.user.username).toBe('quietwriter');
  });

  it('leaves an ordinary channel post with no writer alone', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: CHANNEL_ID, signPosts: true }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
  });

  /**
   * The property the whole feature rests on: the raw id never crosses the wire.
   *
   * If `writtenByOxyUserId` shipped whenever the column held one, `signPosts:
   * false` would stop being anonymous no matter what any renderer chose to draw —
   * so this is asserted on the DISCLOSING case, where the id is least likely to
   * be missed on its way out.
   */
  it('never puts writtenByOxyUserId on the DTO', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: CHANNEL_ID, signPosts: true }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated).not.toHaveProperty('writtenByOxyUserId');
    expect(hydrated.metadata).not.toHaveProperty('writtenByOxyUserId');
    expect(JSON.stringify(hydrated)).not.toContain('writtenByOxyUserId');
  });

  it('reads the whole page of channels in ONE settings query', async () => {
    userSettingsSelect.mockReturnValue([{ oxyUserId: CHANNEL_ID, signPosts: true }]);

    const rows = [
      { ...postRow(CHANNEL_ID, WRITER_ID), _id: '650000000000000000000041' },
      { ...postRow(CHANNEL_ID, WRITER_ID), _id: '650000000000000000000042' },
      { ...postRow(CHANNEL_ID, WRITER_ID), _id: '650000000000000000000043' },
    ];
    const hydrated = await service.hydratePosts(rows, { maxDepth: 0 });

    expect(hydrated).toHaveLength(3);
    for (const post of hydrated) {
      expect(post.authors.map((a) => a.role)).toEqual(['owner', 'writer']);
    }
    // Two `UserSettings.find` calls per hydration, both batched over the page:
    // the viewer-context privacy read and the channel-signing read. Never one
    // per post.
    expect(userSettingsSelect).toHaveBeenCalledTimes(2);
  });

  it('asks the settings collection nothing when no post carries a writer', async () => {
    await service.hydratePosts([postRow(PERSON_ID)], { maxDepth: 0 });

    // Only the viewer-context privacy read — the signing lookup short-circuits
    // on an empty candidate set, so an ordinary page pays nothing for this.
    expect(userSettingsSelect).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE FOUR-PROJECTION HAZARD DOES NOT EXIST ON THIS BRANCH, and that is worth
 * stating rather than silently dropping.
 *
 * On Mongo, `writtenByOxyUserId` had to be named in FOUR separate `select`
 * strings (`mtn/feed/FeedAPI`, `controllers/feed.controller`,
 * `services/ThreadSlicingService`, `routes/search`); missing from one, the
 * writer hydrated `undefined` with no error, so the same post named its writer
 * on a feed row and dropped the name as a thread parent. `main` carried a test
 * asserting all four strings contained the field.
 *
 * Every one of those projections is GONE: each of those readers now assembles a
 * whole `PostRecord` through `db/posts/postRepository`, so there is no field list
 * that can omit a column and no fifth one a future reader could forget. The old
 * test is therefore not ported — it would assert against four string constants
 * that no longer exist, which is a test that can only ever pass or fail for
 * reasons unrelated to its subject.
 *
 * What replaces it is structural: the column is on `PostRecord`, so a reader
 * that failed to carry it would not typecheck.
 */
