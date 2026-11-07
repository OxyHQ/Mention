/**
 * `TrendingService.getTrending` on a cache MISS: the 30-minute entries expire
 * together, so every reader that arrives before the first rebuild lands must
 * share that rebuild, and an unready Redis must be a plain miss rather than a
 * failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const client = vi.hoisted(() => ({
  isReady: true,
  get: vi.fn(),
  setEx: vi.fn(),
}));
vi.mock('../../utils/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/redis')>()),
  getRedisClient: () => client,
  reportRedisConnectionFailure: vi.fn(),
}));

import { trendingService, type TrendingAnswer } from '../../services/TrendingService';

const answer: TrendingAnswer = { trending: [], summary: 'summary', recId: 'rec' };

function stubBuild() {
  return vi
    .spyOn(
      trendingService as unknown as { buildLatest: () => Promise<TrendingAnswer> },
      'buildLatest',
    )
    .mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return answer;
    });
}

beforeEach(() => {
  store.clear();
  client.isReady = true;
  client.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  client.setEx.mockReset();
  vi.restoreAllMocks();
});

describe('TrendingService.getTrending cache miss', () => {
  it('shares one rebuild between concurrent readers of the same shape', async () => {
    const build = stubBuild();

    const results = await Promise.all([
      trendingService.getTrending(20, undefined, ['en']),
      trendingService.getTrending(20, undefined, ['en']),
      trendingService.getTrending(20, undefined, ['en']),
    ]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(results).toEqual([answer, answer, answer]);
  });

  it('builds again for a different shape, and again after the build settled', async () => {
    const build = stubBuild();

    await trendingService.getTrending(20, undefined, ['en']);
    await trendingService.getTrending(20, undefined, ['es']);
    await trendingService.getTrending(20, undefined, ['en']);

    expect(build).toHaveBeenCalledTimes(3);
  });

  it('treats an unready Redis as a miss instead of failing the read', async () => {
    client.isReady = false;
    const build = stubBuild();

    await expect(trendingService.getTrending(10)).resolves.toEqual(answer);

    expect(client.get).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('serves a cached answer without building', async () => {
    const build = stubBuild();
    store.set('trending:latest:20:all:any:any', JSON.stringify(answer));

    await expect(trendingService.getTrending(20)).resolves.toEqual(answer);

    expect(build).not.toHaveBeenCalled();
  });
});
