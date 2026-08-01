import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostVisibility } from '@mention/shared-types';

/**
 * What thread slicing owns for a reply, and what it must NOT own.
 *
 * OWNS: tagging the slice `replyContext` and PREPENDING the parent post so the
 * pair renders as one connected thread. Nothing else can do that — it is a
 * decision about the shape of the page.
 *
 * DOES NOT OWN: whom the reply answers. That is `post.replyContext.parentAuthor`,
 * filled by `PostHydrationService` for every post on every surface (see
 * `postHydrationReplyContext.test.ts`). The slicer used to resolve parent authors
 * too, which made the "Replying to @…" header reachable ONLY through a slice —
 * so it never appeared on the feeds whose definition does not opt into reply
 * slicing, nor on the response paths that emit no slices at all, nor on the
 * screens that render a bare post. Two carriers for one fact, and only one of
 * them reached most of the app.
 *
 * The reason is still emitted when no parent can be prepended, because the
 * `hideReplies` tuner filters on it.
 */

const { postFind } = vi.hoisted(() => ({ postFind: vi.fn() }));

// A chainable Mongoose query stub: every builder method returns `this`; `.lean()`
// resolves the provided rows.
function chainable(rows: unknown[]) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'limit', 'maxTimeMS']) {
    q[m] = () => q;
  }
  q.lean = async () => rows;
  return q;
}

vi.mock('../../models/Post', () => ({
  Post: {
    find: (...args: unknown[]) => chainable(postFind(...args)),
  },
}));

import { threadSlicingService } from '../../services/ThreadSlicingService';

const PARENT_ID = '650000000000000000000001';
const REPLY_ID = '650000000000000000000002';
const PARENT_AUTHOR_ID = 'oxy-parent-author';
const REPLY_AUTHOR_ID = 'oxy-reply-author';

beforeEach(() => {
  postFind.mockReset();
  // Parent is NOT in the feed → fetchParentPosts queries Mongo for it.
  postFind.mockImplementation(() => [
    {
      _id: PARENT_ID,
      oxyUserId: PARENT_AUTHOR_ID,
      parentPostId: undefined,
      threadId: undefined,
      content: { text: 'parent body' },
    },
  ]);
});

describe('ThreadSlicingService reply-context slices', () => {
  it('prepends the parent post and carries an author-free reason', async () => {
    const reply = {
      _id: REPLY_ID,
      oxyUserId: REPLY_AUTHOR_ID,
      parentPostId: PARENT_ID,
      content: { text: 'a reply' },
    };

    const { slices } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: false,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    const replyContextSlice = slices.find((s) => s.reason?.type === 'replyContext');
    expect(replyContextSlice).toBeDefined();
    // The parent is prepended: [parent, reply]. This is the slicer's real job.
    expect(replyContextSlice?.items.map((item) => String(item.post.id ?? (item.post as unknown as { _id: string })._id)))
      .toEqual([PARENT_ID, REPLY_ID]);

    // EXACT shape, not a subset: the reason carries the tag and NOTHING else.
    // An added `parentAuthor` here would mean the author is being resolved twice
    // — once into the slice for a few feeds, once onto the post for all of them —
    // which is the duplication this test exists to prevent.
    expect(replyContextSlice?.reason).toEqual({ type: 'replyContext' });
  });
});

/**
 * A federated reply is linked into its thread only if the outbox connector can
 * resolve — or bounded-backfill — its parent (`outbox.service.ts`,
 * `if (!link) continue`). When the parent is unreachable the reply is stored
 * with `federation.inReplyTo` intact and `parentPostId` left NULL.
 *
 * The slicer used to test `post.parentPostId` and therefore classified those as
 * thread ROOTS: no `replyContext` reason, so the `hideReplies` tuner (which
 * filters on that reason) never saw them either.
 */
describe('ThreadSlicingService replies without a local parent link', () => {
  const FEDERATED_REPLY_ID = '650000000000000000000201';

  beforeEach(() => {
    // No parent to fetch: there is no local id to query for.
    postFind.mockImplementation(() => []);
  });

  it('tags an unlinked federated reply as replyContext', async () => {
    const reply = {
      _id: FEDERATED_REPLY_ID,
      oxyUserId: REPLY_AUTHOR_ID,
      parentPostId: null,
      federation: { inReplyTo: 'https://remote.example/users/someone/statuses/1' },
      content: { text: '@someone thank you!' },
    };

    const { slices } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: true,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    expect(slices).toHaveLength(1);
    expect(slices[0].reason).toEqual({ type: 'replyContext' });
    // The reply is alone in the slice: there is no parent post to prepend.
    expect(slices[0].items).toHaveLength(1);
    // No parent id exists, so the slicer must not have gone looking for one.
    expect(postFind).not.toHaveBeenCalled();
  });

  it('does not treat an unlinked federated reply as a self-thread root', async () => {
    const reply = {
      _id: FEDERATED_REPLY_ID,
      oxyUserId: REPLY_AUTHOR_ID,
      parentPostId: null,
      // A stale/backfilled threadId must not promote a reply to a thread root.
      threadId: 'thread-9',
      federation: { inReplyTo: 'https://remote.example/users/someone/statuses/1' },
      content: { text: 'a federated reply' },
    };

    const { slices } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: true,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    expect(slices[0].reason?.type).toBe('replyContext');
  });

  it('still tags a reply whose parent was already rendered higher in the page', async () => {
    const parent = {
      _id: PARENT_ID,
      oxyUserId: PARENT_AUTHOR_ID,
      parentPostId: null,
      content: { text: 'parent body' },
    };
    const reply = {
      _id: REPLY_ID,
      oxyUserId: REPLY_AUTHOR_ID,
      parentPostId: PARENT_ID,
      content: { text: 'a reply' },
    };

    // Parent first: it is consumed as its own slice, so the reply cannot prepend
    // it again — the case that previously produced an untagged bare slice.
    const { slices } = await threadSlicingService.sliceFeed([parent, reply], {
      enableThreadGrouping: false,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    expect(slices).toHaveLength(2);
    const replySlice = slices[1];
    expect(replySlice.reason).toEqual({ type: 'replyContext' });
    expect(replySlice.items).toHaveLength(1);
  });
});

describe('ThreadSlicingService thread children visibility', () => {
  it('fetches self-thread children only when public and published', async () => {
    postFind.mockImplementation(() => []);

    const root = {
      _id: '650000000000000000000101',
      oxyUserId: 'oxy-thread-author',
      parentPostId: undefined,
      threadId: 'thread-1',
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { text: 'public root' },
    };

    await threadSlicingService.sliceFeed([root], {
      enableThreadGrouping: true,
      enableReplyContext: false,
      maxSliceSize: 3,
    });

    expect(postFind).toHaveBeenCalledTimes(1);
    expect(postFind.mock.calls[0][0]).toMatchObject({
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $or: [
        {
          threadId: 'thread-1',
          oxyUserId: 'oxy-thread-author',
          parentPostId: { $ne: null, $exists: true },
        },
      ],
    });
  });
});
