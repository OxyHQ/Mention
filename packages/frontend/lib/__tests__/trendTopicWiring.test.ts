import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { trendingService } from '@/services/trendingService';
import { useTopicRailStore } from '@/stores/topicRailStore';

const mockGet = jest.fn();

jest.mock('@/utils/api', () => ({
  publicClient: { get: (...args: unknown[]) => mockGet(...args) },
  authenticatedClient: { get: jest.fn() },
}));

describe('publicQueryKeys.trendTopic', () => {
  it('keys the topic by its term, apart from the summary of the same term', () => {
    expect(publicQueryKeys.trendTopic('nvidia')).toEqual(publicQueryKeys.trendTopic('nvidia'));
    expect(publicQueryKeys.trendTopic('nvidia')).not.toEqual(
      publicQueryKeys.trendSummary('nvidia'),
    );
  });
});

describe('trendingService.getTrendTopic', () => {
  beforeEach(() => mockGet.mockReset());

  it('returns what the topic endpoint answers, for the term asked', async () => {
    const topic = { term: 'nvidia', topAuthors: [], related: [], volume: 3 };
    mockGet.mockResolvedValueOnce({ data: topic });

    await expect(trendingService.getTrendTopic('nvidia')).resolves.toEqual(topic);
    expect(mockGet).toHaveBeenCalledWith('/trending/topic', { params: { term: 'nvidia' } });
  });

  it('answers the bare term when the request fails, so the page still renders its title', async () => {
    mockGet.mockRejectedValueOnce(new Error('offline'));

    await expect(trendingService.getTrendTopic('nvidia')).resolves.toEqual({
      term: 'nvidia',
      topAuthors: [],
      related: [],
    });
  });
});

describe('topicRailStore', () => {
  it('holds the open topic and clears it', () => {
    useTopicRailStore.getState().setTerm('nvidia');
    expect(useTopicRailStore.getState().term).toBe('nvidia');

    useTopicRailStore.getState().setTerm(null);
    expect(useTopicRailStore.getState().term).toBeNull();
  });
});
