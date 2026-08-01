import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostVisibility, type PostUser } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Regression harness for the blank reply-context author bug (M9).
 *
 * A `replyContext` slice renders a "Replying to @<parent author>" header from
 * `slice.reason.parentAuthor`. Thread slicing runs on RAW lean post docs BEFORE
 * `PostHydrationService` resolves authors, so the parent's canonical
 * `name.displayName` / handle / avatar are NOT present on the lean doc (only
 * `oxyUserId` is). The old code read `parent.user` (undefined on a lean doc) and
 * serialized `displayName: ''` / `handle: ''` → the header rendered a bare "@".
 *
 * The fix resolves parent authors through the SAME canonical path hydration
 * uses (`resolveUserSummaries`). These tests assert the reply-context author
 * carries the resolved summary and NEVER blanks for an existing parent author.
 */

const { resolveUserSummaries, postFind } = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(),
  postFind: vi.fn(),
}));

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

// Mock only the boundary the slicer now depends on. `resolveUserSummaries` is
// the canonical, batched/Redis-cached author resolver exported by
// PostHydrationService; mocking it keeps this a pure unit test of the slicer.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

import { threadSlicingService } from '../../services/ThreadSlicingService';

const PARENT_ID = '650000000000000000000001';
const REPLY_ID = '650000000000000000000002';
const PARENT_AUTHOR_ID = 'oxy-parent-author';
const REPLY_AUTHOR_ID = 'oxy-reply-author';

function summary(id: string, username: string, displayName: string): CachedUserSummary {
  return {
    user: {
      id,
      username,
      name: { displayName },
      avatar: `${id}-avatar`,
      verified: false,
    },
    followerCount: 0,
  };
}

beforeEach(() => {
  resolveUserSummaries.mockReset();
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

describe('ThreadSlicingService reply-context parent author', () => {
  it('populates parentAuthor from the resolved canonical summary (not blank)', async () => {
    resolveUserSummaries.mockResolvedValue(
      new Map<string, CachedUserSummary>([
        [PARENT_AUTHOR_ID, summary(PARENT_AUTHOR_ID, 'parenthandle', 'Parent Display Name')],
      ]),
    );

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
    const reason = replyContextSlice?.reason;
    expect(reason?.type).toBe('replyContext');
    if (reason?.type !== 'replyContext') throw new Error('expected replyContext reason');

    expect(reason.parentAuthor).toBeDefined();
    const parentAuthor = reason.parentAuthor as PostUser;
    expect(parentAuthor.name.displayName).toBe('Parent Display Name');
    expect(parentAuthor.username).toBe('parenthandle');
    expect(parentAuthor.name.displayName).not.toBe('');
    expect(parentAuthor.id).toBe(PARENT_AUTHOR_ID);

    // The slicer must resolve the PARENT author id through the canonical path.
    expect(resolveUserSummaries).toHaveBeenCalledTimes(1);
    expect(resolveUserSummaries.mock.calls[0][0]).toContain(PARENT_AUTHOR_ID);
  });

  it('emits the degraded (ghost-handle-safe) parent author when it cannot be resolved', async () => {
    // Author resolution returns nothing (e.g. Oxy lookup miss + no FederatedActor).
    resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());

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

    const reason = slices.find((s) => s.reason?.type === 'replyContext')?.reason;
    if (reason?.type !== 'replyContext') throw new Error('expected replyContext reason');

    // Ghost-handle rule: an unresolvable parent carries an EMPTY username and no
    // display name — NEVER the raw oxyUserId as a handle. The renderer then
    // suppresses the "@<handle>" line instead of showing a fake handle.
    expect(reason.parentAuthor?.id).toBe(PARENT_AUTHOR_ID);
    expect(reason.parentAuthor?.username).toBe('');
    expect(reason.parentAuthor?.name.displayName).toBeUndefined();
  });
});

/**
 * A federated reply is linked into its thread only if the outbox connector can
 * resolve — or bounded-backfill — its parent (`outbox.service.ts`,
 * `if (!link) continue`). When the parent is unreachable the reply is stored
 * with `federation.inReplyTo` intact and `parentPostId` left NULL.
 *
 * The slicer used to test `post.parentPostId` and therefore classified those as
 * thread ROOTS: no `replyContext` reason, so the renderer's "Replying to" header
 * never fired and the `hideReplies` tuner (which filters on that same reason)
 * never saw them either. A context-free reply — "@someone thank you!" — rendered
 * as an ordinary top-level post.
 */
describe('ThreadSlicingService replies without a local parent link', () => {
  const FEDERATED_REPLY_ID = '650000000000000000000201';

  beforeEach(() => {
    // No parent to fetch: there is no local id to query for.
    postFind.mockImplementation(() => []);
    resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());
  });

  it('tags an unlinked federated reply as replyContext, with no parentAuthor', async () => {
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
    const reason = slices[0].reason;
    if (reason?.type !== 'replyContext') {
      throw new Error(`expected replyContext reason, got ${String(reason?.type)}`);
    }
    // Nobody to name — but the slice still declares itself a reply, which is what
    // the header and the hideReplies tuner key off.
    expect(reason.parentAuthor).toBeUndefined();
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
    resolveUserSummaries.mockResolvedValue(
      new Map<string, CachedUserSummary>([
        [PARENT_AUTHOR_ID, summary(PARENT_AUTHOR_ID, 'parenthandle', 'Parent Display Name')],
      ]),
    );

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
    const reason = replySlice.reason;
    if (reason?.type !== 'replyContext') {
      throw new Error(`expected replyContext reason, got ${String(reason?.type)}`);
    }
    expect(replySlice.items).toHaveLength(1);
    // The parent doc IS in hand here, so the author still resolves — only the
    // POST cannot be repeated.
    expect(reason.parentAuthor?.username).toBe('parenthandle');
  });
});

describe('ThreadSlicingService thread children visibility', () => {
  it('fetches self-thread children only when public and published', async () => {
    postFind.mockImplementation(() => []);
    resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());

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
