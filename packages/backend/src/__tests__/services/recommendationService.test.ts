import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  blockFind: vi.fn(),
  muteFind: vi.fn(),
  restrictFind: vi.fn(),
  getRedisClient: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  rank: vi.fn(),
  getMentionOxyClientId: vi.fn(),
}));

vi.mock('../../models/Block', () => ({ default: { find: mocks.blockFind } }));
vi.mock('../../models/Mute', () => ({ default: { find: mocks.muteFind } }));
vi.mock('../../models/Restrict', () => ({ default: { find: mocks.restrictFind } }));

vi.mock('../../utils/redis', () => ({
  getRedisClient: mocks.getRedisClient,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getMentionOxyClientId: mocks.getMentionOxyClientId,
}));

// The OxyRankingClient default export is replaced; the service accepts an
// injected client via its constructor, but it also imports the default for the
// no-arg singleton path, so we mock the module to be safe.
vi.mock('../../services/OxyRankingClient', () => ({
  oxyRankingClient: { rank: mocks.rank },
  OxyRankingClient: class {},
}));

import { RecommendationService } from '../../services/RecommendationService';

/** Build a lean-find mock that returns `rows` from `.lean()`. */
function leanFind(rows: unknown[]) {
  return vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(rows) });
}

const rankingClient = { rank: mocks.rank };

function makeService() {
  // The constructor accepts the ranking client; cast through the mocked module's
  // shape which exposes `rank`.
  return new RecommendationService(rankingClient as unknown as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMentionOxyClientId.mockReturnValue('app_1');
  // Redis not ready by default → cache disabled (miss + no write).
  mocks.getRedisClient.mockReturnValue({ isReady: false, get: mocks.redisGet, set: mocks.redisSet });
  mocks.rank.mockResolvedValue([]);
});

describe('RecommendationService.resolveExcludeIds', () => {
  it('unions blocked + muted + restricted ids and always includes self', async () => {
    mocks.blockFind.mockImplementation(leanFind([{ blockedId: 'b1' }, { blockedId: 'b2' }]));
    mocks.muteFind.mockImplementation(leanFind([{ mutedId: 'm1' }, { mutedId: 'b1' }]));
    mocks.restrictFind.mockImplementation(leanFind([{ restrictedId: 'r1' }]));

    const service = makeService();
    const ids = await service.resolveExcludeIds('self_1');

    expect(new Set(ids)).toEqual(new Set(['self_1', 'b1', 'b2', 'm1', 'r1']));
  });

  it('degrades to just self when relation lookups throw', async () => {
    mocks.blockFind.mockImplementation(() => { throw new Error('db down'); });
    mocks.muteFind.mockImplementation(leanFind([]));
    mocks.restrictFind.mockImplementation(leanFind([]));

    const service = makeService();
    const ids = await service.resolveExcludeIds('self_1');
    expect(ids).toEqual(['self_1']);
  });
});

describe('RecommendationService.getRecommendations', () => {
  it('passes the resolved excludeIds + viewerId to the ranking client (authed path)', async () => {
    mocks.blockFind.mockImplementation(leanFind([{ blockedId: 'b1' }]));
    mocks.muteFind.mockImplementation(leanFind([]));
    mocks.restrictFind.mockImplementation(leanFind([]));
    mocks.rank.mockResolvedValue([
      { id: 'r1', name: { displayName: 'Rec One' }, mutualCount: 0, verified: false, isFederated: false, isAgent: false, isAutomated: false, _count: { followers: 0, following: 0 } },
    ]);

    const service = makeService();
    const result = await service.getRecommendations({ viewerId: 'self_1', limit: 5, excludeTypes: ['agent'] });

    expect(mocks.rank).toHaveBeenCalledTimes(1);
    const opts = mocks.rank.mock.calls[0][0];
    expect(opts.viewerId).toBe('self_1');
    expect(opts.limit).toBe(5);
    expect(opts.excludeTypes).toEqual(['agent']);
    expect(new Set(opts.excludeIds)).toEqual(new Set(['self_1', 'b1']));
    // Hydrated DTO preserves canonical displayName.
    expect(result.recommendations[0].name.displayName).toBe('Rec One');
  });

  it('logged-out path: no excludeIds, viewerId undefined', async () => {
    const service = makeService();
    await service.getRecommendations({ limit: 10 });

    expect(mocks.blockFind).not.toHaveBeenCalled();
    const opts = mocks.rank.mock.calls[0][0];
    expect(opts.viewerId).toBeUndefined();
    expect(opts.excludeIds).toBeUndefined();
  });

  it('caps the limit at MAX and defaults when omitted', async () => {
    const service = makeService();
    await service.getRecommendations({ limit: 9999 });
    expect(mocks.rank.mock.calls[0][0].limit).toBe(50);

    mocks.rank.mockClear();
    await service.getRecommendations({});
    expect(mocks.rank.mock.calls[0][0].limit).toBe(20);
  });

  it('returns a cached page WITHOUT calling the ranking client (cache hit)', async () => {
    const cached = [
      { id: 'cached', name: { displayName: 'Cached' }, mutualCount: 0, verified: false, isFederated: false, isAgent: false, isAutomated: false, _count: { followers: 0, following: 0 } },
    ];
    mocks.redisGet.mockResolvedValue(JSON.stringify(cached));
    mocks.getRedisClient.mockReturnValue({ isReady: true, get: mocks.redisGet, set: mocks.redisSet });

    const service = makeService();
    const result = await service.getRecommendations({ limit: 10 });

    expect(result.recommendations).toEqual(cached);
    expect(mocks.rank).not.toHaveBeenCalled();
  });

  it('writes to cache on a miss', async () => {
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue('OK');
    mocks.getRedisClient.mockReturnValue({ isReady: true, get: mocks.redisGet, set: mocks.redisSet });
    mocks.rank.mockResolvedValue([
      { id: 'r1', name: { displayName: 'R1' }, mutualCount: 0, verified: false, isFederated: false, isAgent: false, isAutomated: false, _count: { followers: 0, following: 0 } },
    ]);

    const service = makeService();
    await service.getRecommendations({ limit: 10 });

    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    const [key, value, options] = mocks.redisSet.mock.calls[0];
    expect(typeof key).toBe('string');
    expect(JSON.parse(value)[0].id).toBe('r1');
    expect(options).toHaveProperty('EX');
  });

  it('soft-fails to an empty result when the ranking client throws', async () => {
    mocks.rank.mockRejectedValue(new Error('oxy down'));

    const service = makeService();
    const result = await service.getRecommendations({ viewerId: 'self_1', limit: 10 });
    expect(result).toEqual({ recommendations: [] });
  });
});
