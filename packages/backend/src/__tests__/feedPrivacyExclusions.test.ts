import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Viewer author-exclusions (blocked ∪ muted) applied to a built feed page.
 *
 * Two representations reach this code and only one of them is ever populated:
 * a SLICED page (`slices` authoritative, `items` its flat mirror) and a FLAT
 * page (`slices: []`, posts live in `items` — `saved`, the profile likes tab,
 * `feedgen|<uri>`, the popular fallback). The regression these tests pin is that
 * the exclusion pass re-flattened `items` from `slices` unconditionally, which
 * (a) emptied every flat page for any viewer with a single block or mute, and
 * (b) resurrected posts the item-level pass had just removed, because the slice
 * pass only ever looked at the slice's ANCHOR.
 *
 * The engine and the privacy loader are mocked: this is the controller's
 * filter → respond flow, not a query test.
 */

const engineRun = vi.fn(async (
  _definition?: unknown,
  _context?: Record<string, unknown>,
): Promise<unknown> => ({
  slices: [],
  items: [],
  hasMore: false,
  nextCursor: undefined,
  totalCount: 0,
}));
vi.mock('../mtn/feed/engine/FeedEngine', () => ({
  feedEngine: { run: (...a: unknown[]) => engineRun(...(a as [])), peekLatest: vi.fn(async () => undefined) },
}));

vi.mock('../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getBlockedUsers: vi.fn(async () => []),
    getRestrictedUsers: vi.fn(async () => []),
    getUserFollowing: vi.fn(async () => ({ data: [] })),
    getUserFollowers: vi.fn(async () => ({ data: [] })),
    getMutualUserIds: vi.fn(async () => []),
  }),
}));

const privacy = vi.hoisted(() => ({
  loadPrivacyState: vi.fn(async (): Promise<{ excludedUserIds: Set<string> }> => ({
    excludedUserIds: new Set<string>(),
  })),
}));
vi.mock('../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: { loadPrivacyState: privacy.loadPrivacyState },
}));

vi.mock('../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn((_req?: unknown): unknown => ({
    getBlockedUsers: vi.fn(async () => []),
    getRestrictedUsers: vi.fn(async () => []),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  })),
}));
vi.mock('../services/ListSubscriptionService', () => ({
  listSubscriptionService: { getSubscribedListMemberIds: vi.fn(async () => []) },
}));
vi.mock('../services/laneVisibility', () => ({
  ownerHasProfileAffectingLane: vi.fn(async () => false),
}));
vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: {
    getUserBehavior: vi.fn(async () => undefined),
    getTopRegion: vi.fn(() => undefined),
  },
}));
vi.mock('../services/anonFeedCache', () => ({
  anonFeedCache: {
    read: vi.fn(async (): Promise<unknown> => null),
    write: vi.fn(async (): Promise<void> => undefined),
    buildKey: vi.fn((): string => 'anon-key'),
  },
}));
vi.mock('../connectors/federatedProfileSync', () => ({
  federatedProfileSync: { syncOnProfileView: vi.fn(async () => false) },
}));
/**
 * Pass-through tuner pipeline.
 *
 * Two reasons, and the second is not optional: whatever is missing from a
 * response below has to be the exclusion pass's doing and nothing else's — AND
 * `FeedTuner.default()` cannot run under vitest at all, because it lazily
 * `require()`s its tuner modules and CJS `require` does not resolve a `.ts`
 * specifier in the ESM test runtime (it resolves against the compiled `.js` in
 * production). Any controller test that produces a NON-EMPTY `slices` array
 * reaches that call and 500s without this.
 */
vi.mock('../mtn/feed/FeedTuner', () => ({
  FeedTuner: {
    default: () => ({ apply: (slices: unknown[]) => slices }),
  },
}));
// No muted words: the tuner pipeline that runs after the exclusion pass must be
// a pass-through here, so anything missing from the response is the exclusion
// pass's doing and nothing else's.
vi.mock('../services/safety/viewerSafety', () => ({
  loadMuteWords: vi.fn(async () => []),
  loadShowSensitiveContent: vi.fn(async () => true),
  loadMutedLaneIds: vi.fn(async () => []),
}));

import { mtnFeedController } from '../mtn/controllers/feed.controller';

const VIEWER = 'viewer1';
const MUTED = 'mutedAuthor';
const ALLOWED = 'allowedAuthor';

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}
function makeRes(): MockRes {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/** Minimal hydrated-post stand-in; the controller's filter reads `user.id` only. */
function post(id: string, authorId: string): Record<string, unknown> {
  return { id, user: { id: authorId }, content: { text: id }, metadata: {} };
}

function sliceItem(id: string, authorId: string): Record<string, unknown> {
  return {
    post: post(id, authorId),
    isThreadParent: false,
    isThreadChild: false,
    isThreadLastChild: false,
  };
}

/** A `[parent, reply]` reply-context slice, exactly as ThreadSlicingService builds it. */
function replyContextSlice(
  parent: { id: string; author: string },
  reply: { id: string; author: string },
): Record<string, unknown> {
  return {
    _sliceKey: `${parent.id}+${reply.id}`,
    items: [
      { ...sliceItem(parent.id, parent.author), isThreadParent: true },
      { ...sliceItem(reply.id, reply.author), isThreadChild: true, isThreadLastChild: true },
    ],
    isIncompleteThread: true,
    reason: { type: 'replyContext' },
  };
}

function singleSlice(id: string, authorId: string): Record<string, unknown> {
  return {
    _sliceKey: id,
    items: [sliceItem(id, authorId)],
    isIncompleteThread: false,
  };
}

function excludes(...ids: string[]): void {
  privacy.loadPrivacyState.mockResolvedValue({ excludedUserIds: new Set(ids) });
}

interface FeedBody {
  success: boolean;
  data: {
    slices: Array<{
      _sliceKey: string;
      items: Array<{
        post: { id: string; user: { id: string } };
        isThreadParent: boolean;
        isThreadChild: boolean;
        isThreadLastChild: boolean;
      }>;
      reason?: { type: string };
    }>;
    items: Array<{ id: string; user: { id: string } }>;
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
  };
}

async function getFeed(descriptor: string): Promise<FeedBody['data']> {
  const req = {
    query: { descriptor },
    user: { id: VIEWER },
    headers: { authorization: 'Bearer viewer-token' },
  } as never;
  const res = makeRes();
  await mtnFeedController.getFeed(req, res as never);
  const body = res.body as FeedBody;
  expect(body.success).toBe(true);
  return body.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  privacy.loadPrivacyState.mockResolvedValue({ excludedUserIds: new Set<string>() });
});

describe('MtnFeedController author exclusions → flat feeds', () => {
  /**
   * `saved` runs the engine's `ordered` path: posts in `items`, `slices: []`.
   * Re-flattening from the empty `slices` wiped the whole page, so every viewer
   * with one block or mute saw an empty Bookmarks screen (and an empty profile
   * Likes tab, which is the same shape).
   */
  it('keeps the surviving items of a flat feed when the viewer has exclusions', async () => {
    engineRun.mockResolvedValueOnce({
      slices: [],
      items: [post('p1', ALLOWED), post('p2', MUTED), post('p3', ALLOWED)],
      hasMore: true,
      nextCursor: 'cursor-2',
      totalCount: 3,
    });
    excludes(MUTED);

    const data = await getFeed('saved');

    expect(data.items.map((item) => item.id)).toEqual(['p1', 'p3']);
    expect(data.totalCount).toBe(2);
    expect(data.slices).toEqual([]);
    // Pagination describes how far the SOURCE was consumed; dropping a muted
    // author must not be mistaken for reaching the end of it.
    expect(data.hasMore).toBe(true);
    expect(data.nextCursor).toBe('cursor-2');
  });

  it('serves a flat feed untouched when the exclusion set is empty', async () => {
    engineRun.mockResolvedValueOnce({
      slices: [],
      items: [post('p1', ALLOWED), post('p2', MUTED)],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 2,
    });

    const data = await getFeed('saved');

    expect(data.items.map((item) => item.id)).toEqual(['p1', 'p2']);
    expect(data.totalCount).toBe(2);
  });

  it('empties a flat feed only when every item is by an excluded author', async () => {
    engineRun.mockResolvedValueOnce({
      slices: [],
      items: [post('p1', MUTED), post('p2', MUTED)],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 2,
    });
    excludes(MUTED);

    const data = await getFeed('saved');

    expect(data.items).toEqual([]);
    expect(data.totalCount).toBe(0);
  });
});

describe('MtnFeedController author exclusions → sliced feeds', () => {
  /**
   * The leak: a reply-context slice is `[parent, reply]`, so the anchor is the
   * PARENT. An anchor-only slice test passes the excluded author's reply
   * straight through, and re-flattening `items` from `slices` then put it back
   * even though the item-level pass had removed it.
   */
  it('drops the whole slice when the excluded author wrote the REPLY, not the anchor', async () => {
    engineRun.mockResolvedValueOnce({
      slices: [
        replyContextSlice({ id: 'parent1', author: ALLOWED }, { id: 'reply1', author: MUTED }),
        singleSlice('p9', ALLOWED),
      ],
      items: [post('parent1', ALLOWED), post('reply1', MUTED), post('p9', ALLOWED)],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 3,
    });
    excludes(MUTED);

    const data = await getFeed('following');

    expect(data.items.map((item) => item.id)).toEqual(['p9']);
    expect(data.slices).toHaveLength(1);
    expect(data.slices[0]._sliceKey).toBe('p9');
    expect(data.totalCount).toBe(1);
  });

  /**
   * The mirrored judgement: the reply's own author is allowed, so the reply is a
   * legitimate feed candidate and survives — only the muted PARENT is trimmed
   * out of its context. Muting someone hides their posts, not everyone who
   * answers them. The degraded lone-reply slice is a shape the slicer already
   * emits whenever the parent is unavailable.
   */
  it('trims only the excluded PARENT and keeps the reply, renormalizing the slice', async () => {
    engineRun.mockResolvedValueOnce({
      slices: [replyContextSlice({ id: 'parent1', author: MUTED }, { id: 'reply1', author: ALLOWED })],
      items: [post('parent1', MUTED), post('reply1', ALLOWED)],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 2,
    });
    excludes(MUTED);

    const data = await getFeed('following');

    expect(data.slices).toHaveLength(1);
    expect(data.slices[0].items.map((item) => item.post.id)).toEqual(['reply1']);
    // Key recomputed off the survivors, so the dedupe tuner and the client are
    // not keying a one-item slice by a two-post key.
    expect(data.slices[0]._sliceKey).toBe('reply1');
    // Thread flags reassigned: a one-item slice carries no thread state.
    expect(data.slices[0].items[0]).toMatchObject({
      isThreadParent: false,
      isThreadChild: false,
      isThreadLastChild: false,
    });
    // The reason survives, so the `hideReplies` tuner still sees a reply.
    expect(data.slices[0].reason?.type).toBe('replyContext');
    expect(data.items.map((item) => item.id)).toEqual(['reply1']);
    expect(data.totalCount).toBe(1);
  });

  it('drops a single-post slice whose author is excluded', async () => {
    engineRun.mockResolvedValueOnce({
      slices: [singleSlice('p1', MUTED), singleSlice('p2', ALLOWED)],
      items: [post('p1', MUTED), post('p2', ALLOWED)],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 2,
    });
    excludes(MUTED);

    const data = await getFeed('following');

    expect(data.slices.map((slice) => slice._sliceKey)).toEqual(['p2']);
    expect(data.items.map((item) => item.id)).toEqual(['p2']);
    expect(data.totalCount).toBe(2 - 1);
  });

  it('serves a sliced feed untouched when the exclusion set is empty', async () => {
    engineRun.mockResolvedValueOnce({
      slices: [
        replyContextSlice({ id: 'parent1', author: MUTED }, { id: 'reply1', author: ALLOWED }),
        singleSlice('p9', MUTED),
      ],
      items: [post('parent1', MUTED), post('reply1', ALLOWED), post('p9', MUTED)],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 3,
    });

    const data = await getFeed('following');

    expect(data.slices.map((slice) => slice._sliceKey)).toEqual(['parent1+reply1', 'p9']);
    expect(data.slices[0].items.map((item) => item.post.id)).toEqual(['parent1', 'reply1']);
    expect(data.items.map((item) => item.id)).toEqual(['parent1', 'reply1', 'p9']);
    expect(data.totalCount).toBe(3);
  });
});
