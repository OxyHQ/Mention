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

const { getUserById, getUsersByIds, cacheStore, userSettingsFind } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  userSettingsFind: vi.fn(),
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

/** Chainable Mongoose query stub — builder methods return `this`, `.lean()` resolves the rows. */
function chainable(rows: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'limit', 'maxTimeMS']) {
    q[m] = () => q;
  }
  q.lean = async () => rows;
  q.then = undefined;
  return q;
}

vi.mock('../../models/Post', () => ({
  Post: {
    find: () => chainable([]),
    findOne: () => chainable(null),
    aggregate: async () => [],
  },
}));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Lane', () => ({ Lane: { find: () => chainable([]) } }));
// ONE stub serves both `UserSettings.find` callers — the viewer-context privacy
// read and the channel-signing read. Neither cares about the other's fields.
vi.mock('../../models/UserSettings', () => ({
  UserSettings: {
    find: () => chainable(userSettingsFind()),
    findOne: () => chainable(null),
  },
}));
vi.mock('../../models/StarterPack', () => ({
  StarterPack: { aggregate: async () => [] },
  default: { aggregate: async () => [] },
}));
vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
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
    userSettingsFind.mockReset();

    userSettingsFind.mockReturnValue([]);
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
    userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: true } }]);

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
    userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: false } }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
    // Not merely unrendered: the writer was never even resolved, so no identity
    // of theirs was fetched, cached or held anywhere in this request.
    expect(requestedIds()).not.toContain(WRITER_ID);
  });

  it('discloses NOBODY when the channel has no settings row at all', async () => {
    userSettingsFind.mockReturnValue([]);

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
    userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: 'false' } }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
    expect(requestedIds()).not.toContain(WRITER_ID);
  });

  it('discloses NOBODY when the settings lookup fails — it fails CLOSED', async () => {
    userSettingsFind.mockImplementation(() => {
      throw new Error('mongo is down');
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
    userSettingsFind.mockReturnValue([{ oxyUserId: PERSON_ID, channel: { signPosts: true } }]);

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
    userSettingsFind.mockReturnValue([
      { oxyUserId: CHANNEL_ID, channel: { signPosts: true } },
      { oxyUserId: QUIET_CHANNEL_ID, channel: { signPosts: false } },
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
    userSettingsFind.mockReturnValue([{ oxyUserId: QUIET_CHANNEL_ID, channel: { signPosts: false } }]);

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
    userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: true } }]);

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
    userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: true } }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], { maxDepth: 0 });

    expect(hydrated).not.toHaveProperty('writtenByOxyUserId');
    expect(hydrated.metadata).not.toHaveProperty('writtenByOxyUserId');
    expect(JSON.stringify(hydrated)).not.toContain('writtenByOxyUserId');
  });

  it('reads the whole page of channels in ONE settings query', async () => {
    userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: true } }]);

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
    expect(userSettingsFind).toHaveBeenCalledTimes(2);
  });

  it('asks the settings collection nothing when no post carries a writer', async () => {
    await service.hydratePosts([postRow(PERSON_ID)], { maxDepth: 0 });

    // Only the viewer-context privacy read — the signing lookup short-circuits
    // on an empty candidate set, so an ordinary page pays nothing for this.
    expect(userSettingsFind).toHaveBeenCalledTimes(1);
  });
});

/**
 * All FOUR projections, not two.
 *
 * A field missing from one hydrates as `undefined` with no error, and the worst
 * spelling of that here is forgetting the SLICER's: the writer is named on the
 * feed row and unnamed on the SAME post rendered as a thread parent, which reads
 * like a caching bug.
 */
describe('writtenByOxyUserId is projected on every path that hydrates a post', () => {
  it('is in FEED_FIELDS (the MTN engine)', async () => {
    const { FEED_FIELDS } = await import('../../mtn/feed/FeedAPI');
    expect(FEED_FIELDS.split(' ')).toContain('writtenByOxyUserId');
  });

  it('is in the three other projections', async () => {
    const [{ readFile }, path] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const root = path.resolve(__dirname, '../..');
    const sources = await Promise.all([
      readFile(path.join(root, 'controllers/feed.controller.ts'), 'utf8'),
      readFile(path.join(root, 'services/ThreadSlicingService.ts'), 'utf8'),
      readFile(path.join(root, 'routes/search.ts'), 'utf8'),
    ]);

    // Vacuity floor: the files were really read.
    for (const source of sources) expect(source.length).toBeGreaterThan(1000);

    expect(sources[0]).toMatch(/FEED_FIELDS = '[^']*\bwrittenByOxyUserId\b/);
    expect(sources[1]).toMatch(/SLICE_POST_PROJECTION =\s*'[^']*\bwrittenByOxyUserId\b/);
    expect(sources[2]).toMatch(/'writtenByOxyUserId',/);
  });
});

/**
 * Who the post MENU is drawn for.
 *
 * `viewerState.isOwner` is the single flag the client's three-dot menu reads —
 * delete, edit, pin, move to lane, reply options all hang off it. Derived from
 * `authorship` alone it is false for everybody on a channel post, because the
 * only entry there is the CHANNEL and no session can ever have a channel as its
 * subject. The symptom is a post whose author cannot manage it.
 *
 * Independent of the byline: disclosure is the channel's choice (`signPosts`),
 * while managing your own writing is not, so a channel that signs nothing still
 * gives its writer the menu.
 */
describe('PostHydrationService — who may manage a channel post', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    userSettingsFind.mockReset();
    userSettingsFind.mockReturnValue([]);
    getUserById.mockResolvedValue(null);
    getUsersByIds.mockImplementation(async (ids: string[]) =>
      [CHANNEL_ACCOUNT, WRITER_ACCOUNT, PERSON_ACCOUNT].filter((u) => ids.includes(u.id)),
    );
    service = new PostHydrationService();
  });

  it('gives the WRITER the menu, though authorship names only the channel', async () => {
    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], {
      maxDepth: 0,
      viewerId: WRITER_ID,
    });

    expect(hydrated.viewerState?.isOwner).toBe(true);
    expect(hydrated.permissions?.canDelete).toBe(true);
    expect(hydrated.permissions?.canEdit).toBe(true);
    expect(hydrated.permissions?.canPin).toBe(true);
    // The row that made it false: the writer is deliberately absent from here.
    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
  });

  it('does so even when the channel signs NOTHING', async () => {
    // Disclosure and management are different questions. A channel that keeps
    // its writers anonymous still lets them manage what they wrote.
    userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: false } }]);

    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], {
      maxDepth: 0,
      viewerId: WRITER_ID,
    });

    expect(hydrated.viewerState?.isOwner).toBe(true);
    expect(hydrated.authors.map((a) => a.id)).toEqual([CHANNEL_ID]);
  });

  it('gives NOBODY ELSE the menu on that post', async () => {
    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], {
      maxDepth: 0,
      viewerId: PERSON_ID,
    });

    expect(hydrated.viewerState?.isOwner).toBe(false);
    expect(hydrated.permissions?.canDelete).toBe(false);
  });

  it('CONTROL: an ordinary author still gets it, and a stranger still does not', async () => {
    // Without this the two assertions above would pass on a predicate that had
    // simply stopped granting anybody anything.
    const [mine] = await service.hydratePosts([postRow(PERSON_ID)], {
      maxDepth: 0,
      viewerId: PERSON_ID,
    });
    expect(mine.viewerState?.isOwner).toBe(true);

    const [theirs] = await service.hydratePosts([postRow(PERSON_ID)], {
      maxDepth: 0,
      viewerId: WRITER_ID,
    });
    expect(theirs.viewerState?.isOwner).toBe(false);
  });

  it('still ships no writer id on the DTO', async () => {
    // Granting the menu must not become a second way to leak the column the
    // anonymity rule keeps off the wire.
    const [hydrated] = await service.hydratePosts([postRow(CHANNEL_ID, WRITER_ID)], {
      maxDepth: 0,
      viewerId: WRITER_ID,
    });

    expect(JSON.stringify(hydrated)).not.toContain(WRITER_ID);
  });
});
