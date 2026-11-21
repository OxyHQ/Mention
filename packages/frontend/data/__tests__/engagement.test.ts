import { setActiveStore, Store } from '@oxy.so/bloom-data';
import type { FeedItem } from '@/db/schema';
import {
  boostPost,
  downvotePost,
  likePost,
  savePost,
  unboostPost,
  unlikePost,
  unsavePost,
} from '../engagement';
import { getPost, Post } from '../posts';

const mockFeedService = {
  voteItem: jest.fn(),
  removeVote: jest.fn(),
  saveItem: jest.fn(),
  unsaveItem: jest.fn(),
  createBoost: jest.fn(),
  unboostItem: jest.fn(),
};
jest.mock('@/services/feedService', () => ({
  feedService: new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        (...args: unknown[]) =>
          mockFeedService[name as keyof typeof mockFeedService](...args),
    },
  ),
}));
const mockInvalidate = jest.fn();
jest.mock('@/stores/engagementInvalidation', () => ({
  invalidateEngagementLists: (kind: string) => mockInvalidate(kind),
}));
const mockCounts = jest.fn();
jest.mock('@/stores/profileCountsInvalidation', () => ({
  invalidateProfileCounts: () => mockCounts(),
}));
jest.mock('@/lib/queryClient', () => ({ queryClient: {} }));
const mockMarked: string[] = [];
jest.mock('@/services/echoGuard', () => ({
  markLocalAction: (id: string, action: string) => mockMarked.push(`${id}:${action}`),
}));

function seed(
  state: Partial<FeedItem['viewerState']>,
  engagement: Partial<FeedItem['engagement']>,
) {
  Post.put({
    id: 'p',
    viewerState: { isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false, ...state },
    engagement: { likes: 5, downvotes: 0, boosts: 2, saves: 3, replies: 0, ...engagement },
  } as unknown as FeedItem);
}
const ok = (data: unknown = {}) => ({ success: true, data });
const state = () => getPost('p')?.viewerState;
const counts = () => getPost('p')?.engagement;

beforeEach(() => {
  jest.clearAllMocks();
  mockMarked.length = 0;
  setActiveStore(new Store());
});

describe('engagement actions', () => {
  it('an unlike takes the like back and settles to the server count', async () => {
    seed({ isLiked: true }, { likes: 5 });
    mockFeedService.removeVote.mockResolvedValue(ok({ likesCount: 3, liked: false }));
    const done = unlikePost('p');
    expect(counts()?.likes).toBe(4);
    await done;
    expect(counts()?.likes).toBe(3);
    expect(state()?.isLiked).toBe(false);
    expect(mockInvalidate).toHaveBeenCalledWith('like');
    expect(mockMarked).toEqual(['p:unlike']);
  });

  it('an unlike of a post not liked changes nothing locally', async () => {
    seed({}, { likes: 5 });
    mockFeedService.removeVote.mockResolvedValue(ok());
    await unlikePost('p');
    expect(counts()?.likes).toBe(5);
  });

  it('a like keeps the server’s word over its own guess, and leaves counts alone without one', async () => {
    seed({}, { likes: 5 });
    mockFeedService.voteItem.mockResolvedValue(ok({}));
    await likePost('p', 'feed:for_you');
    expect(mockFeedService.voteItem).toHaveBeenCalledWith('p', 1, 'feed:for_you');
    expect(counts()?.likes).toBe(6);
    expect(state()?.isLiked).toBe(true);
  });

  it('a downvote clears a like and counts the downvote, then settles both counts', async () => {
    seed({ isLiked: true }, { likes: 5, downvotes: 1 });
    mockFeedService.voteItem.mockResolvedValue(
      ok({ likesCount: 4, downvotesCount: 7, liked: false, downvoted: true }),
    );
    const done = downvotePost('p');
    expect(counts()).toMatchObject({ likes: 4, downvotes: 2 });
    expect(state()).toMatchObject({ isLiked: false, isDownvoted: true });
    await done;
    expect(counts()).toMatchObject({ likes: 4, downvotes: 7 });
    expect(mockInvalidate).toHaveBeenCalledWith('like');
  });

  it('a second downvote is a no-op locally', async () => {
    seed({ isDownvoted: true }, { downvotes: 1 });
    mockFeedService.voteItem.mockResolvedValue(ok());
    await downvotePost('p');
    expect(counts()?.downvotes).toBe(1);
  });

  it('a boost and its undo move the count and refresh the profile counters', async () => {
    seed({}, { boosts: 2 });
    mockFeedService.createBoost.mockResolvedValue(ok());
    mockFeedService.unboostItem.mockResolvedValue(ok());
    await boostPost('p', 'feed:for_you');
    expect(counts()?.boosts).toBe(3);
    expect(state()?.isBoosted).toBe(true);
    await unboostPost('p');
    expect(counts()?.boosts).toBe(2);
    expect(state()?.isBoosted).toBe(false);
    expect(mockCounts).toHaveBeenCalledTimes(2);
    expect(mockInvalidate).toHaveBeenCalledWith('boost');
  });

  it('an unsave takes the save back and settles to the server count', async () => {
    seed({ isSaved: true }, { saves: 3 });
    mockFeedService.unsaveItem.mockResolvedValue(ok({ savesCount: 9 }));
    await unsavePost('p');
    expect(counts()?.saves).toBe(9);
    expect(state()?.isSaved).toBe(false);
  });

  it('leaves a save count it never had for the server to fill', async () => {
    seed({}, { saves: null as never });
    mockFeedService.saveItem.mockResolvedValue(ok({}));
    await savePost('p');
    expect(counts()?.saves).toBeNull();
    expect(state()?.isSaved).toBe(true);
  });

  it('rolls back a call the server did not confirm, and rejects', async () => {
    seed({}, { boosts: 2 });
    mockFeedService.createBoost.mockResolvedValue({ success: false });
    await expect(boostPost('p')).rejects.toThrow('Failed to boost');
    expect(counts()?.boosts).toBe(2);
    expect(state()?.isBoosted).toBe(false);
  });
});
