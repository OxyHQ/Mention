import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostActorSummary } from '@mention/shared-types';
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

function summary(id: string, handle: string, displayName: string): CachedUserSummary {
  return {
    summary: {
      id,
      handle,
      displayName,
      avatarUrl: `https://cloud.oxy.so/${id}?variant=thumb`,
      avatar: `https://cloud.oxy.so/${id}?variant=thumb`,
      isVerified: false,
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

    const parentAuthor: PostActorSummary = reason.parentAuthor;
    expect(parentAuthor.displayName).toBe('Parent Display Name');
    expect(parentAuthor.handle).toBe('parenthandle');
    expect(parentAuthor.displayName).not.toBe('');
    expect(parentAuthor.id).toBe(PARENT_AUTHOR_ID);

    // The slicer must resolve the PARENT author id through the canonical path.
    expect(resolveUserSummaries).toHaveBeenCalledTimes(1);
    expect(resolveUserSummaries.mock.calls[0][0]).toContain(PARENT_AUTHOR_ID);
  });

  it('never emits a blank displayName/handle when the author cannot be resolved', async () => {
    // Author resolution returns nothing (e.g. Oxy lookup miss).
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

    // Falls back to the parent author id for BOTH fields — never an empty string,
    // so the rendered "@<handle>" is never a bare "@".
    expect(reason.parentAuthor.handle).toBe(PARENT_AUTHOR_ID);
    expect(reason.parentAuthor.displayName).toBe(PARENT_AUTHOR_ID);
    expect(reason.parentAuthor.handle).not.toBe('');
    expect(reason.parentAuthor.displayName).not.toBe('');
  });
});
