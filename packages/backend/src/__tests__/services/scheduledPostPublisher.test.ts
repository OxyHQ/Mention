import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scheduledPostPublisher } from '../../services/ScheduledPostPublisher';
import { Post } from '../../models/Post';
import { postCreationService } from '../../services/PostCreationService';

vi.mock('../../models/Post', () => ({
  Post: { find: vi.fn() },
}));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    claimAndPublishScheduledPost: vi.fn(async ({ postId }: { postId: string }) => ({ _id: postId })),
  },
}));

/** The claim the sweep drives each due post through. */
const claim = postCreationService.claimAndPublishScheduledPost as unknown as ReturnType<typeof vi.fn>;

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
    claim.mockReset();
    claim.mockImplementation(async ({ postId }: { postId: string }) => ({ _id: postId }));
    (Post.find as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('publishes every due scheduled post and returns the count', async () => {
    const due = [{ _id: 'a' }, { _id: 'b' }];
    mockDuePosts(due);

    const published = await scheduledPostPublisher.publishDuePosts();

    expect(published).toBe(2);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('queries only scheduled posts whose time has passed', async () => {
    mockDuePosts([]);
    const now = new Date('2026-01-01T00:00:00.000Z');

    const published = await scheduledPostPublisher.publishDuePosts(now);

    expect(published).toBe(0);
    expect(Post.find).toHaveBeenCalledWith({ status: 'scheduled', scheduledFor: { $lte: now } });
    expect(claim).not.toHaveBeenCalled();
  });

  it('isolates a failing post so the rest of the batch still publishes', async () => {
    const due = [{ _id: 'ok-1' }, { _id: 'boom' }, { _id: 'ok-2' }];
    mockDuePosts(due);
    claim.mockImplementation(async ({ postId }: { postId: string }) => {
      if (postId === 'boom') throw new Error('publish failed');
      return { _id: postId };
    });

    const published = await scheduledPostPublisher.publishDuePosts();

    expect(published).toBe(2);
    expect(claim).toHaveBeenCalledTimes(3);
  });

  /**
   * The sweep CLAIMS rather than publishing a document it already holds. Between
   * the `find` above and the write, the author can publish the same post early
   * from the composer; handing the loaded document straight to
   * `publishScheduledPost` would federate it, write its MTN record and notify
   * twice. Going through the claim is what makes that impossible, so the sweep
   * has to be shown to take that route — with the post's ID, since the claim
   * re-reads it under a condition rather than trusting the stale copy.
   */
  it('goes through the CLAIM, by id, so it cannot double-publish behind the author', async () => {
    mockDuePosts([{ _id: 'a' }]);

    await scheduledPostPublisher.publishDuePosts();

    expect(claim).toHaveBeenCalledWith({ postId: 'a' });
  });

  /**
   * A lost claim is the author having published early — the post DID go out, just
   * not by this sweep's hand. Counting it would inflate the log line; treating it
   * as a failure would log an error for the system working exactly as designed.
   */
  it('does not count a post another caller claimed first', async () => {
    mockDuePosts([{ _id: 'mine' }, { _id: 'theirs' }]);
    claim.mockImplementation(async ({ postId }: { postId: string }) =>
      postId === 'theirs' ? null : { _id: postId },
    );

    const published = await scheduledPostPublisher.publishDuePosts();

    expect(published).toBe(1);
  });
});
