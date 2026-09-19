/**
 * `GET /search/overview` is the request this change exists to make: four
 * client requests where there were seven, with hashtags, lists, feeds and
 * starter packs fanned out server-side.
 *
 * What is pinned here is the part that is easy to lose and impossible to see
 * once lost. The old client fanned out with `Promise.allSettled` and collapsed
 * a REJECTED source into an empty section, so a lane that was down rendered as
 * a confident "no results" — indistinguishable, to a reader, from a query that
 * genuinely matched nothing. The overview contract carries a per-lane `status`
 * precisely so the client can tell those apart, and a test is the only thing
 * that keeps the client from throwing the distinction away again.
 */
import { searchService } from '../searchService';

const mockAuthGet = jest.fn();
const mockPublicGet = jest.fn();
const mockSearchProfiles = jest.fn();
const mockGetProfileByUsername = jest.fn();
const mockGetSavedPosts = jest.fn();
const mockOxyHttpGet = jest.fn();
const mockWarn = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: (...args: unknown[]) => mockAuthGet(...args) },
  publicClient: { get: (...args: unknown[]) => mockPublicGet(...args) },
  isUnauthorizedError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    searchProfiles: (...args: unknown[]) => mockSearchProfiles(...args),
    getProfileByUsername: (...args: unknown[]) => mockGetProfileByUsername(...args),
    httpService: { get: (...args: unknown[]) => mockOxyHttpGet(...args) },
  },
}));

jest.mock('@/services/feedService', () => ({
  feedService: { getSavedPosts: (...args: unknown[]) => mockGetSavedPosts(...args) },
}));

jest.mock('@/utils/storage', () => ({
  Storage: { get: jest.fn(), set: jest.fn(), remove: jest.fn() },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

/** A lane in the shape the contract declares: always present, always with a status. */
function lane(status: string, items: unknown[] = []) {
  return { status, items, hasMore: false, tookMs: 1 };
}

function overview(lanes: Record<string, unknown>) {
  return {
    data: {
      query: 'q',
      lanes: {
        feeds: lane('ok'),
        hashtags: lane('ok'),
        lists: lane('ok'),
        starterPacks: lane('ok'),
        ...lanes,
      },
      degraded: false,
      servedFromCache: false,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOxyHttpGet.mockResolvedValue({ data: [], pagination: { total: 0 } });
  mockSearchProfiles.mockResolvedValue([]);
  mockAuthGet.mockResolvedValue({ data: { data: [] } });
  mockGetSavedPosts.mockResolvedValue({ posts: [] });
});

describe('the search overview lane contract', () => {
  it('asks the public overview once and spreads its four lanes', async () => {
    mockPublicGet.mockResolvedValue(overview({
      hashtags: lane('ok', [{ tag: 'climate', count: 3 }]),
      lists: lane('ok', [{ id: 'list-1', title: 'Reporters' }]),
      feeds: lane('ok', [{ id: 'feed-1', title: 'Science' }]),
      starterPacks: lane('ok', [{ id: 'pack-1', name: 'Newsroom' }]),
    }));

    const results = await searchService.searchAll('climate', false);

    const overviewCalls = mockPublicGet.mock.calls.filter(([url]) => url === '/search/overview');
    expect(overviewCalls).toHaveLength(1);
    expect(overviewCalls[0][1]).toMatchObject({ params: { q: 'climate' } });
    expect(results.hashtags).toHaveLength(1);
    expect(results.lists).toHaveLength(1);
    expect(results.feeds).toHaveLength(1);
    expect(results.starterPacks).toHaveLength(1);
  });

  /**
   * The load-bearing case. A lane that FAILED and a lane that genuinely matched
   * nothing must not be the same value on the way out, or the section-level
   * "unavailable" UI can never be built on top of it — and until then, the
   * operator has no signal at all that a lane is down.
   */
  it.each(['error', 'timeout'])('logs a %s lane instead of passing it off as no results', async (status) => {
    mockPublicGet.mockResolvedValue(overview({
      lists: lane(status),
      hashtags: lane('ok', [{ tag: 'climate', count: 3 }]),
    }));

    const results = await searchService.searchAll('climate', false);

    expect(results.lists).toEqual([]);
    expect(results.hashtags).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'A search lane did not complete',
      expect.objectContaining({ lane: 'lists', status }),
    );
  });

  it('says nothing about a lane that is simply empty', async () => {
    mockPublicGet.mockResolvedValue(overview({ lists: lane('ok', []) }));

    const results = await searchService.searchAll('climate', false);

    expect(results.lists).toEqual([]);
    expect(mockWarn).not.toHaveBeenCalledWith(
      'A search lane did not complete',
      expect.anything(),
    );
  });

  /**
   * The overview is mounted on the PUBLIC api, so a signed-out viewer gets real
   * results from it — the reason `canUsePrivateApi` no longer gates the lists
   * lane. The auth-gated sources stay quiet rather than 401.
   */
  it('serves a signed-out viewer without touching the authenticated api', async () => {
    mockPublicGet.mockResolvedValue(overview({
      feeds: lane('ok', [{ id: 'feed-1', title: 'Science' }]),
    }));

    const results = await searchService.searchAll('climate', false);

    expect(results.feeds).toHaveLength(1);
    expect(mockAuthGet).not.toHaveBeenCalled();
    expect(mockGetSavedPosts).not.toHaveBeenCalled();
    expect(results.posts).toEqual([]);
    expect(results.saved).toEqual([]);
  });

  /**
   * A response without `lanes` is a CONTRACT breach, not an empty result. It has
   * to REJECT, so it reaches `searchAll`'s rejection accounting and is logged as
   * a failed source — rather than being read as four lanes that each matched
   * nothing, which is the same silent lie the per-lane statuses exist to stop.
   * The people lane is independent and still renders.
   */
  it('treats a response carrying no lanes as a failed source, not an empty one', async () => {
    mockPublicGet.mockResolvedValue({ data: { query: 'q' } });
    mockOxyHttpGet.mockResolvedValue({
      data: [{ id: 'user-1', username: 'alice' }],
      pagination: { total: 1 },
    });

    const results = await searchService.searchAll('climate', false);

    expect(mockWarn).toHaveBeenCalledWith(
      'A search source failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(results.users).toHaveLength(1);
  });

  /** Every active source down is the one case that surfaces as an error. */
  it('throws when the overview and the people lane both fail', async () => {
    mockPublicGet.mockRejectedValue(new Error('overview down'));
    mockOxyHttpGet.mockRejectedValue(new Error('people down'));
    mockSearchProfiles.mockRejectedValue(new Error('people down'));
    mockGetProfileByUsername.mockRejectedValue(new Error('people down'));

    await expect(searchService.searchAll('climate', false)).rejects.toThrow();
  });

  it('passes the caller\'s abort signal to the overview request', async () => {
    mockPublicGet.mockResolvedValue(overview({}));
    const controller = new AbortController();

    await searchService.searchAll('climate', false, controller.signal);

    const [, options] = mockPublicGet.mock.calls.find(([url]) => url === '/search/overview')!;
    expect(options).toMatchObject({ signal: controller.signal });
  });
});
