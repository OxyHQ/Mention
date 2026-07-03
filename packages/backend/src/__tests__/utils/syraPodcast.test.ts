import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodeSummary, SearchPage } from '@syra.fm/sdk';

/**
 * Unit coverage for the server-side Syra episode resolvers. The `@syra.fm/sdk`
 * factory is mocked so the REAL `listPodcastEpisodes` / `resolvePodcastEpisode`
 * run against a controllable stub client — the same instance the module assigns
 * to `syraClient`. Redis is mocked to a healthy, controllable client so the
 * fail-open cache is exercised deterministically (hit vs. miss vs. write).
 *
 * Asserts the denormalization (never trusting the client), the podcast-id
 * cross-check, the tri-state resolve contract (ok / not_found / unavailable),
 * the positive cache (hit skips the SDK, miss writes it), and — critically —
 * that the picker list NEVER leaks a playable audio URL.
 */

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
}));

vi.mock('@syra.fm/sdk', () => ({
  createSyraClient: vi.fn(() => ({
    getEpisode: vi.fn(),
    getPodcastEpisodes: vi.fn(),
    episodeImageUrl: vi.fn(),
  })),
  // Minimal stand-in for the SDK's `SyraApiError` so `instanceof` behaves in the
  // resolver. Defined inside the (hoisted) factory to avoid a top-level ref.
  SyraApiError: class SyraApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'SyraApiError';
      this.status = status;
    }
  },
}));

// Controllable Redis: healthy + ready so `ensureRedisConnected` passes and the
// cache get/set ops actually run against `redisGet` / `redisSetEx`.
vi.mock('../../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: mocks.redisGet,
    setEx: mocks.redisSetEx,
  }),
}));

import { syraClient, listPodcastEpisodes, resolvePodcastEpisode } from '../../utils/syraPodcast';
import { SyraApiError } from '@syra.fm/sdk';

const getEpisode = vi.mocked(syraClient.getEpisode);
const getPodcastEpisodes = vi.mocked(syraClient.getPodcastEpisodes);
const episodeImageUrl = vi.mocked(syraClient.episodeImageUrl);

/** Build a full episode-summary fixture; overrides win over the defaults. */
function makeEpisode(overrides: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    id: 'ep-1',
    podcastId: 'show-1',
    title: 'Episode One',
    enclosureUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
    enclosureType: 'audio/mpeg',
    duration: 3600,
    pubDate: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default to a cache MISS; individual tests opt into a hit.
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSetEx.mockResolvedValue('OK');
});

describe('resolvePodcastEpisode', () => {
  it('denormalizes a resolved episode into its playable form (status ok)', async () => {
    getEpisode.mockResolvedValue(makeEpisode());
    episodeImageUrl.mockReturnValue('https://cdn.syra.fm/art/ep-1.jpg');

    const result = await resolvePodcastEpisode('ep-1', 'show-1');

    expect(getEpisode).toHaveBeenCalledWith('ep-1');
    expect(result).toEqual({
      status: 'ok',
      episode: {
        audioUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
        title: 'Episode One',
        artworkUrl: 'https://cdn.syra.fm/art/ep-1.jpg',
        durationSec: 3600,
      },
    });
  });

  it('writes the resolved episode to the cache on a miss', async () => {
    getEpisode.mockResolvedValue(makeEpisode());
    episodeImageUrl.mockReturnValue('https://cdn.syra.fm/art/ep-1.jpg');

    await resolvePodcastEpisode('ep-1', 'show-1');

    expect(mocks.redisSetEx).toHaveBeenCalledWith(
      'syrapodcast:episode:v1:ep-1',
      300,
      JSON.stringify({
        podcastId: 'show-1',
        audioUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
        title: 'Episode One',
        artworkUrl: 'https://cdn.syra.fm/art/ep-1.jpg',
        durationSec: 3600,
      }),
    );
  });

  it('serves a cache hit without calling the SDK', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({
        podcastId: 'show-1',
        audioUrl: 'https://api.fastcast.ai/audio/cached.mp3',
        title: 'Cached Episode',
        durationSec: 120,
      }),
    );

    const result = await resolvePodcastEpisode('ep-1', 'show-1');

    expect(getEpisode).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ok',
      episode: {
        audioUrl: 'https://api.fastcast.ai/audio/cached.mp3',
        title: 'Cached Episode',
        artworkUrl: undefined,
        durationSec: 120,
      },
    });
  });

  it('cross-checks the show even on a cache hit (not_found on mismatch)', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({ podcastId: 'other-show', audioUrl: 'x', title: 'y' }),
    );

    const result = await resolvePodcastEpisode('ep-1', 'show-1');

    expect(getEpisode).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns not_found when the episode belongs to a different show', async () => {
    getEpisode.mockResolvedValue(makeEpisode({ podcastId: 'other-show' }));

    const result = await resolvePodcastEpisode('ep-1', 'show-1');

    expect(result).toEqual({ status: 'not_found' });
  });

  it('resolves without cross-check when no expected podcast id is passed', async () => {
    getEpisode.mockResolvedValue(makeEpisode({ podcastId: 'whatever' }));
    episodeImageUrl.mockReturnValue(undefined);

    const result = await resolvePodcastEpisode('ep-1');

    expect(result).toEqual({
      status: 'ok',
      episode: {
        audioUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
        title: 'Episode One',
        artworkUrl: undefined,
        durationSec: 3600,
      },
    });
  });

  it('returns not_found when Syra answers 4xx (definitive no such episode)', async () => {
    getEpisode.mockRejectedValue(new SyraApiError(404, 'not found'));

    await expect(resolvePodcastEpisode('missing', 'show-1')).resolves.toEqual({ status: 'not_found' });
    expect(mocks.redisSetEx).not.toHaveBeenCalled();
  });

  it('returns unavailable when Syra 5xxs (outage, retryable)', async () => {
    getEpisode.mockRejectedValue(new SyraApiError(503, 'service unavailable'));

    await expect(resolvePodcastEpisode('ep-1', 'show-1')).resolves.toEqual({ status: 'unavailable' });
    expect(mocks.redisSetEx).not.toHaveBeenCalled();
  });

  it('returns unavailable on a non-HTTP transport error', async () => {
    getEpisode.mockRejectedValue(new Error('network down'));

    await expect(resolvePodcastEpisode('ep-1', 'show-1')).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('listPodcastEpisodes', () => {
  it('maps each episode to a picker row and passes pagination through', async () => {
    const page: SearchPage<EpisodeSummary> = {
      items: [makeEpisode()],
      hasMore: true,
      offset: 20,
      limit: 20,
    };
    getPodcastEpisodes.mockResolvedValue(page);
    episodeImageUrl.mockReturnValue('https://cdn.syra.fm/art/ep-1.jpg');

    const result = await listPodcastEpisodes('show-1', { offset: 20 });

    expect(getPodcastEpisodes).toHaveBeenCalledWith('show-1', { offset: 20 });
    expect(result).toEqual({
      items: [
        {
          episodeId: 'ep-1',
          title: 'Episode One',
          durationSec: 3600,
          publishedAt: '2026-07-01T00:00:00.000Z',
          artworkUrl: 'https://cdn.syra.fm/art/ep-1.jpg',
        },
      ],
      hasMore: true,
      offset: 20,
      limit: 20,
    });
  });

  it('serves a cache hit without calling the SDK', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({
        items: [{ episodeId: 'ep-cached', title: 'Cached' }],
        hasMore: false,
        offset: 0,
        limit: 20,
      }),
    );

    const result = await listPodcastEpisodes('show-1');

    expect(getPodcastEpisodes).not.toHaveBeenCalled();
    expect(result).toEqual({
      items: [{ episodeId: 'ep-cached', title: 'Cached' }],
      hasMore: false,
      offset: 0,
      limit: 20,
    });
  });

  it('never leaks a playable audio URL to the picker row', async () => {
    getPodcastEpisodes.mockResolvedValue({
      items: [makeEpisode()],
      hasMore: false,
      offset: 0,
      limit: 20,
    });
    episodeImageUrl.mockReturnValue(undefined);

    const { items } = await listPodcastEpisodes('show-1');

    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('audioUrl');
    expect(items[0]).not.toHaveProperty('enclosureUrl');
    expect(Object.values(items[0])).not.toContain('https://api.fastcast.ai/audio/ep-1.mp3');
  });
});
