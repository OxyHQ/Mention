import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Reply-context parents must clear the same publication bar as the feed
 * candidates they are injected next to.
 *
 * `fetchParentPosts` looks parents up by raw `_id` — the reply itself came from a
 * feed source that filtered `status: 'published'`, but its PARENT was fetched
 * with no such filter, and `status` was left out of the projection. That second
 * omission is what made `PostHydrationService`'s guard
 * (`(post.status ?? 'published') !== 'published'`) inert: with the field
 * unprojected it reads `undefined`, defaults to `'published'`, and never fires —
 * so a draft or scheduled parent's full content would be emitted into a public
 * feed as reply context.
 *
 * Unlike the sibling reply-context suite, the Post stub here HONOURS the query
 * filter and the `.select()` projection, so both halves of the fix are asserted
 * by behaviour: drop the query clause and the draft parent reappears in the
 * slice; drop `status` from the projection and the parent reaches hydration
 * without the field its guard reads.
 */

const { resolveUserSummaries, seededPosts } = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(),
  seededPosts: [] as Record<string, unknown>[],
}));

/** The `$in` / equality subset of Mongo these two slicer queries actually build. */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') {
      return Array.isArray(cond)
        && cond.some((sub) => matches(doc, sub as Record<string, unknown>));
    }
    if (cond && typeof cond === 'object' && '$in' in (cond as Record<string, unknown>)) {
      const values = (cond as { $in: unknown[] }).$in;
      return values.some((v) => String(v) === String(doc[key]));
    }
    if (cond && typeof cond === 'object' && '$ne' in (cond as Record<string, unknown>)) {
      return doc[key] !== (cond as { $ne: unknown }).$ne;
    }
    return doc[key] === cond;
  });
}

/** Mongo drops every field a projection omits; so does this. */
function project(doc: Record<string, unknown>, projection: string): Record<string, unknown> {
  const fields = new Set(projection.split(/\s+/).filter(Boolean));
  return Object.fromEntries(Object.entries(doc).filter(([key]) => fields.has(key)));
}

vi.mock('../../models/Post', () => ({
  Post: {
    find: (filter: Record<string, unknown>) => {
      const rows = seededPosts.filter((doc) => matches(doc, filter));
      const query: Record<string, unknown> = {
        select: (projection: string) => {
          query.lean = async () => rows.map((doc) => project(doc, projection));
          return query;
        },
        sort: () => query,
        limit: () => query,
        maxTimeMS: () => query,
        lean: async () => rows,
      };
      return query;
    },
  },
}));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

import { threadSlicingService } from '../../services/ThreadSlicingService';

const PARENT_ID = '650000000000000000000011';
const REPLY_ID = '650000000000000000000012';
const PARENT_AUTHOR_ID = 'oxy-parent-author';
const REPLY_AUTHOR_ID = 'oxy-reply-author';

function seedParent(status: 'draft' | 'published' | 'scheduled') {
  seededPosts.push({
    _id: PARENT_ID,
    oxyUserId: PARENT_AUTHOR_ID,
    visibility: PostVisibility.PUBLIC,
    status,
    content: { text: 'the unpublished parent body' },
  });
}

const reply = {
  _id: REPLY_ID,
  oxyUserId: REPLY_AUTHOR_ID,
  parentPostId: PARENT_ID,
  visibility: PostVisibility.PUBLIC,
  status: 'published',
  content: { text: 'a public reply' },
};

async function sliceReply() {
  return threadSlicingService.sliceFeed([reply], {
    enableThreadGrouping: false,
    enableReplyContext: true,
    maxSliceSize: 3,
  });
}

/** The post ids the slicer actually put in a slice. */
function slicedPostIds(slices: { items: { post: unknown }[] }[]): string[] {
  return slices.flatMap((slice) =>
    slice.items.map((item) => String((item.post as { _id: unknown })._id)),
  );
}

beforeEach(() => {
  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());
  seededPosts.length = 0;
});

describe('ThreadSlicingService reply-context parent publication', () => {
  it.each(['draft', 'scheduled'] as const)(
    'never emits a %s parent as reply context',
    async (status) => {
      seedParent(status);

      const { slices, additionalPostIds } = await sliceReply();

      expect(slicedPostIds(slices)).toEqual([REPLY_ID]);
      expect(additionalPostIds).not.toContain(PARENT_ID);
      expect(JSON.stringify(slices)).not.toContain('the unpublished parent body');
    },
  );

  it('emits a published parent as reply context', async () => {
    seedParent('published');

    const { slices, additionalPostIds } = await sliceReply();

    expect(slicedPostIds(slices)).toEqual([PARENT_ID, REPLY_ID]);
    expect(additionalPostIds).toContain(PARENT_ID);
  });

  // Defence in depth behind the query filter above: hydration re-checks post ACL
  // per viewer, and its unpublished guard can only fire on a doc that actually
  // CARRIES `status`. An unprojected field silently defaults to 'published'.
  it('hands the parent to hydration with its status, so the unpublished guard is not inert', async () => {
    seedParent('published');

    const { slices } = await sliceReply();

    const parent = slices
      .flatMap((slice) => slice.items)
      .map((item) => item.post as unknown as { _id: unknown; status?: string })
      .find((post) => String(post._id) === PARENT_ID);

    expect(parent).toBeDefined();
    expect(parent?.status).toBe('published');
  });
});
