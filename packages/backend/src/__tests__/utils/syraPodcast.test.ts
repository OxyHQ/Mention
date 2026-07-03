import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodeSummary, SearchPage } from '@syra.fm/sdk';

/**
 * Unit coverage for the server-side Syra episode resolvers. The `@syra.fm/sdk`
 * factory is mocked so the REAL `listPodcastEpisodes` / `resolvePodcastEpisode`
 * run against a controllable stub client — the same instance the module assigns
 * to `syraClient`. Asserts the denormalization (never trusting the client), the
 * podcast-id cross-check, the throw-becomes-null contract, and — critically —
 * that the picker list NEVER leaks a playable audio URL.
 */

vi.mock('@syra.fm/sdk', () => ({
  createSyraClient: vi.fn(() => ({
    getEpisode: vi.fn(),
    getPodcastEpisodes: vi.fn(),
    episodeImageUrl: vi.fn(),
  })),
}));

import { syraClient, listPodcastEpisodes, resolvePodcastEpisode } from '../../utils/syraPodcast';

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
});

describe('resolvePodcastEpisode', () => {
  it('denormalizes a resolved episode into its playable form', async () => {
    getEpisode.mockResolvedValue(makeEpisode());
    episodeImageUrl.mockReturnValue('https://cdn.syra.fm/art/ep-1.jpg');

    const result = await resolvePodcastEpisode('ep-1', 'show-1');

    expect(getEpisode).toHaveBeenCalledWith('ep-1');
    expect(result).toEqual({
      audioUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
      title: 'Episode One',
      artworkUrl: 'https://cdn.syra.fm/art/ep-1.jpg',
      durationSec: 3600,
    });
  });

  it('returns null when the episode belongs to a different show', async () => {
    getEpisode.mockResolvedValue(makeEpisode({ podcastId: 'other-show' }));

    const result = await resolvePodcastEpisode('ep-1', 'show-1');

    expect(result).toBeNull();
  });

  it('resolves without cross-check when no expected podcast id is passed', async () => {
    getEpisode.mockResolvedValue(makeEpisode({ podcastId: 'whatever' }));
    episodeImageUrl.mockReturnValue(undefined);

    const result = await resolvePodcastEpisode('ep-1');

    expect(result).toEqual({
      audioUrl: 'https://api.fastcast.ai/audio/ep-1.mp3',
      title: 'Episode One',
      artworkUrl: undefined,
      durationSec: 3600,
    });
  });

  it('returns null (never throws) when the SDK cannot resolve the episode', async () => {
    getEpisode.mockRejectedValue(new Error('not found'));

    await expect(resolvePodcastEpisode('missing', 'show-1')).resolves.toBeNull();
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
