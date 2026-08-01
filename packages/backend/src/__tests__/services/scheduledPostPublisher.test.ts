import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scheduledPostPublisher } from '../../services/ScheduledPostPublisher';
import { Post } from '../../models/Post';
import { postCreationService } from '../../services/PostCreationService';

vi.mock('../../models/Post', () => ({
  Post: { find: vi.fn() },
}));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    publishScheduledPost: vi.fn(async (post: unknown) => post),
  },
}));

/** Build the `.sort().limit()` query chain `publishDuePosts` awaits. */
function mockDuePosts(duePosts: unknown[]) {
  (Post.find as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    sort: vi.fn(() => ({
      limit: vi.fn(async () => duePosts),
    })),
  });
}

describe('ScheduledPostPublisher', () => {
  beforeEach(() => {
    (postCreationService.publishScheduledPost as unknown as ReturnType<typeof vi.fn>).mockClear();
    (Post.find as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('publishes every due scheduled post and returns the count', async () => {
    const due = [{ _id: 'a' }, { _id: 'b' }];
    mockDuePosts(due);

    const published = await scheduledPostPublisher.publishDuePosts();

    expect(published).toBe(2);
    expect(postCreationService.publishScheduledPost).toHaveBeenCalledTimes(2);
  });

  it('queries only scheduled posts whose time has passed', async () => {
    mockDuePosts([]);
    const now = new Date('2026-01-01T00:00:00.000Z');

    const published = await scheduledPostPublisher.publishDuePosts(now);

    expect(published).toBe(0);
    expect(Post.find).toHaveBeenCalledWith({ status: 'scheduled', scheduledFor: { $lte: now } });
    expect(postCreationService.publishScheduledPost).not.toHaveBeenCalled();
  });

  it('isolates a failing post so the rest of the batch still publishes', async () => {
    const due = [{ _id: 'ok-1' }, { _id: 'boom' }, { _id: 'ok-2' }];
    mockDuePosts(due);
    (postCreationService.publishScheduledPost as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (post: { _id: string }) => {
        if (post._id === 'boom') throw new Error('publish failed');
        return post;
      },
    );

    const published = await scheduledPostPublisher.publishDuePosts();

    expect(published).toBe(2);
    expect(postCreationService.publishScheduledPost).toHaveBeenCalledTimes(3);
  });
});
