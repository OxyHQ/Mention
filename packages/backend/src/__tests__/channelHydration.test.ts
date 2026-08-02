import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The channel signature on the post DTO — and the anonymity it enforces.
 *
 * THREE failures this guards, in ascending order of consequence:
 *
 *  1. A missing projection hydrates as `undefined` with NO error, so the signature
 *     appears on one code path and not another — which reads like a caching bug.
 *  2. `post.user` must stay the canonical Oxy `User` shape. Nothing may fabricate
 *     one from a channel: that would break `/@handle` links and poison the
 *     identity cache. The channel travels as its OWN field, and the renderer
 *     decides.
 *  3. With `signPosts: false` the writer must not travel AT ALL. Hiding them only
 *     in the UI is not anonymity when anyone can read the API response — so this
 *     is asserted on the DTO, and asserted to FAIL CLOSED when the channel row
 *     cannot be loaded.
 */

const channelFind = vi.fn();
vi.mock('../models/Channel', () => ({
  Channel: { find: (...args: unknown[]) => channelFind(...args) },
}));

vi.mock('../models/Lane', () => ({
  Lane: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

function chainReturning(rows: unknown[]) {
  const link = {
    select: () => link,
    sort: () => link,
    limit: () => link,
    lean: () => Promise.resolve(rows),
  };
  return link;
}

const emptyChain = () => chainReturning([]);

/** What the graph collector's `Post.find` answers — referenced posts, if any. */
let referencedPosts: unknown[] = [];
const postFind = vi.fn(() => chainReturning(referencedPosts));
vi.mock('../models/Post', () => ({
  Post: {
    find: (...args: unknown[]) => postFind(...(args as [])),
    aggregate: vi.fn(async () => []),
  },
}));
vi.mock('../models/Like', () => ({ default: { find: () => emptyChain() } }));
vi.mock('../models/Bookmark', () => ({ default: { find: () => emptyChain() } }));
vi.mock('../models/Poll', () => ({ default: { find: () => emptyChain() } }));
vi.mock('../models/FederatedActor', () => ({
  FederatedActor: { find: () => emptyChain() },
  default: { find: () => emptyChain() },
}));
vi.mock('../models/UserSettings', () => ({
  UserSettings: { find: () => emptyChain(), findOne: () => ({ lean: async () => null }) },
  default: { find: () => emptyChain(), findOne: () => ({ lean: async () => null }) },
}));
vi.mock('../services/PostRecentReplierService', () => ({
  loadRecentReplierIds: vi.fn(async () => ({
    perPostRepliers: new Map<string, string[]>(),
    allReplierIds: new Set<string>(),
  })),
}));

import { postHydrationService } from '../services/PostHydrationService';
import { FEED_FIELDS } from '../mtn/feed/FeedAPI';

const AUTHOR_ID = 'author-1';
const CHANNEL_ID = new mongoose.Types.ObjectId().toString();

function channelRow(signPosts: boolean) {
  return {
    _id: CHANNEL_ID,
    handle: 'newsroom',
    title: 'The Newsroom',
    avatar: 'file_abc',
    signPosts,
  };
}

function rawPost(id: string, extra: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(id),
    oxyUserId: AUTHOR_ID,
    authorship: [{ oxyUserId: AUTHOR_ID, role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text: 'hello' }] },
    visibility: 'public',
    status: 'published',
    stats: {},
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...extra,
  };
}

/** Every string anywhere in the DTO — used to prove an id does NOT travel. */
function serialized(value: unknown): string {
  return JSON.stringify(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  referencedPosts = [];
  channelFind.mockReturnValue({ select: () => ({ lean: async () => [channelRow(true)] }) });
});

describe('post hydration — the channel signature', () => {
  it('emits the channel summary as its OWN field, never as post.user', async () => {
    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439011', { channelId: CHANNEL_ID })],
      { includeLinkMetadata: false },
    );

    expect(hydrated?.channel).toEqual({
      id: CHANNEL_ID,
      handle: 'newsroom',
      title: 'The Newsroom',
      avatar: 'file_abc',
      signPosts: true,
    });
    // `user` is still the canonical Oxy shape — the channel was NOT fabricated
    // into one. A `PostUser` built from a channel would break `/@handle` links.
    expect(hydrated?.user?.id).toBe(AUTHOR_ID);
    expect(hydrated?.user).not.toHaveProperty('handle');
  });

  it('omits the field entirely on a post with no channel, and issues no query', async () => {
    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439012')],
      { includeLinkMetadata: false },
    );

    expect(hydrated).toBeDefined();
    expect('channel' in (hydrated ?? {})).toBe(false);
    // The overwhelming majority of posts: it must cost nothing.
    expect(channelFind).not.toHaveBeenCalled();
  });

  it('batches every channel in the graph into ONE deduped query', async () => {
    await postHydrationService.hydratePosts(
      [
        rawPost('507f1f77bcf86cd799439014', { channelId: CHANNEL_ID }),
        rawPost('507f1f77bcf86cd799439015', { channelId: CHANNEL_ID }),
      ],
      { includeLinkMetadata: false },
    );

    expect(channelFind).toHaveBeenCalledTimes(1);
    expect(channelFind).toHaveBeenCalledWith({ _id: { $in: [CHANNEL_ID] } });
  });

  it('propagates to a BOOSTED original — which is what makes "reposted by X" work', async () => {
    const ORIGINAL_ID = '507f1f77bcf86cd799439021';
    referencedPosts = [rawPost(ORIGINAL_ID, { channelId: CHANNEL_ID })];

    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439020', { boostOf: ORIGINAL_ID, oxyUserId: 'booster-1',
        authorship: [{ oxyUserId: 'booster-1', role: 'owner', status: 'accepted' }] })],
      { includeLinkMetadata: false, maxDepth: 1 },
    );

    // The boost is how a channel post reaches its writer's own profile, and the
    // row it paints is the ORIGINAL — signed by the channel — with "reposted by"
    // above it. That works only because the embedded original carries `channel`.
    expect(hydrated?.boost?.originalPost?.channel?.handle).toBe('newsroom');
  });
});

describe('post hydration — anonymity when signPosts is false', () => {
  it('strips the writer from the DTO entirely', async () => {
    channelFind.mockReturnValue({ select: () => ({ lean: async () => [channelRow(false)] }) });

    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439031', { channelId: CHANNEL_ID })],
      { includeLinkMetadata: false },
    );

    expect(hydrated?.channel?.signPosts).toBe(false);
    // Not merely a different display name: the author's id must not appear
    // ANYWHERE in the response. An opaque identifier is still an identifier.
    expect(serialized(hydrated)).not.toContain(AUTHOR_ID);
    expect(hydrated?.user?.username).toBe('');
    expect(hydrated?.authors).toEqual([]);
  });

  it('FAILS CLOSED: a channel row that will not load anonymizes rather than signs', async () => {
    // The condition is "has a channel and that channel did not say to sign it",
    // NOT "the channel says not to sign it" — so a lookup failure cannot publish
    // the writer. This is the single most consequential branch in the file.
    channelFind.mockReturnValue({
      select: () => ({ lean: async () => { throw new Error('mongo down'); } }),
    });

    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439032', { channelId: CHANNEL_ID })],
      { includeLinkMetadata: false },
    );

    expect(hydrated).toBeDefined();
    expect(hydrated?.channel).toBeUndefined();
    expect(serialized(hydrated)).not.toContain(AUTHOR_ID);
  });

  it('CONTROL: an ordinary post keeps its author', async () => {
    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439033')],
      { includeLinkMetadata: false },
    );

    expect(hydrated?.user?.id).toBe(AUTHOR_ID);
    expect(hydrated?.authors?.length).toBe(1);
  });

  it('CONTROL: signPosts true keeps the writer alongside the channel', async () => {
    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439034', { channelId: CHANNEL_ID })],
      { includeLinkMetadata: false },
    );

    expect(hydrated?.channel?.signPosts).toBe(true);
    expect(hydrated?.user?.id).toBe(AUTHOR_ID);
    expect(hydrated?.authors?.length).toBe(1);
  });
});

/**
 * All FOUR projections, not two.
 *
 * A field missing from one of them hydrates as `undefined` with no error. For a
 * channel that is worse than a missing chip: the post loses its signature AND, on
 * a `signPosts: false` channel, the writer's identity comes back — because the
 * anonymity is keyed off the very field that went missing.
 */
describe('channelId is projected on every path that hydrates a post', () => {
  it('is in FEED_FIELDS (the MTN engine)', () => {
    expect(FEED_FIELDS.split(' ')).toContain('channelId');
  });

  it('is in the three other projections', async () => {
    const [{ readFile }, path] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const root = path.resolve(__dirname, '..');
    const sources = await Promise.all([
      readFile(path.join(root, 'controllers/feed.controller.ts'), 'utf8'),
      readFile(path.join(root, 'services/ThreadSlicingService.ts'), 'utf8'),
      readFile(path.join(root, 'routes/search.ts'), 'utf8'),
    ]);

    // Vacuity floor: the files were really read.
    for (const source of sources) expect(source.length).toBeGreaterThan(1000);

    expect(sources[0]).toMatch(/FEED_FIELDS = '[^']*\bchannelId\b/);
    expect(sources[1]).toMatch(/SLICE_POST_PROJECTION =\s*'[^']*\bchannelId\b/);
    expect(sources[2]).toMatch(/'channelId',/);
  });
});
