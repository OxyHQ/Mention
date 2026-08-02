import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Reply-context parents must clear the same publication bar as the feed
 * candidates they are injected next to.
 *
 * `fetchParentPosts` looks parents up by id. The reply itself came from a feed
 * source that filtered `status: 'published'`, but its PARENT was fetched with no
 * such filter and `status` was left out of the projection. That second omission
 * is what made `PostHydrationService`'s guard
 * (`(post.status ?? 'published') !== 'published'`) inert: with the field absent
 * it reads `undefined`, defaults to `'published'`, and never fires — so a draft
 * or scheduled parent's full content would be emitted into a public feed as
 * reply context.
 *
 * ## What changed with the Postgres port
 *
 * There is no projection any more — `findPostRecords` assembles the whole record
 * — so the second half of the old fix is now structural. What remains testable,
 * and what this file is about, is the publication FILTER: an unpublished parent
 * must not come back at all. The old suite hand-built a Mongo stub that
 * interpreted `$in` / `$ne` / `.select()` itself, which meant it was asserting
 * against a re-implementation of Mongo written in the test file. These are real
 * rows and the real query; the leak assertion reads the emitted slices for the
 * parent's actual stored body.
 *
 * `resolveUserSummaries` stays mocked: it is the Oxy identity boundary, not part
 * of this port.
 */

const { resolveUserSummaries } = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { threadSlicingService } from '../../services/ThreadSlicingService';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = serviceScope('thread-slicing-parent-publication');
const PARENT_AUTHOR_ID = scope.user('parent-author');
const REPLY_AUTHOR_ID = scope.user('reply-author');

/** The body only the parent carries — the string a leak would put on the wire. */
const PARENT_BODY = 'the unpublished parent body';

function seedParent(status: 'draft' | 'published' | 'scheduled'): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: PARENT_AUTHOR_ID,
    status,
    // A scheduled post carries a due date; without one the row describes a state
    // the publisher would never produce.
    ...(status === 'scheduled' ? { scheduledFor: new Date(Date.now() + 3_600_000) } : {}),
    content: { variants: [{ source: 'author', text: PARENT_BODY, tag: 'en' }] },
  });
}

function seedReply(parentId: string): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: REPLY_AUTHOR_ID,
    parentPostId: parentId,
    content: { variants: [{ source: 'author', text: 'a public reply', tag: 'en' }] },
  });
}

/**
 * The post ids the slicer actually put in a slice.
 *
 * Read off `id`, the ported field, for BOTH the feed candidate and the parent
 * the slicer fetched itself — a row that never became an `id` is precisely the
 * defect this reads through.
 */
function slicedPostIds(slices: { items: { post: unknown }[] }[]): string[] {
  return slices.flatMap((slice) =>
    slice.items.map((item) => String((item.post as { id: unknown }).id)),
  );
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('ThreadSlicingService reply-context parent publication', () => {
  it.each(['draft', 'scheduled'] as const)(
    'never emits a %s parent as reply context',
    async (status) => {
      const parent = await seedParent(status);
      const reply = await seedReply(parent.id);

      const { slices, additionalPostIds } = await threadSlicingService.sliceFeed([reply], {
        enableThreadGrouping: false,
        enableReplyContext: true,
        maxSliceSize: 3,
      });

      expect(slicedPostIds(slices)).toEqual([reply.id]);
      expect(additionalPostIds).not.toContain(parent.id);
      // Not merely absent from the id list — none of its BODY reached the wire.
      expect(JSON.stringify(slices)).not.toContain(PARENT_BODY);
    },
  );

  it('emits a published parent as reply context', async () => {
    const parent = await seedParent('published');
    const reply = await seedReply(parent.id);

    const { slices, additionalPostIds } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: false,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    expect(slicedPostIds(slices)).toEqual([parent.id, reply.id]);
    expect(additionalPostIds).toContain(parent.id);
    // The published control proves the two cases above are the FILTER firing and
    // not the fetch failing for some unrelated reason.
    expect(JSON.stringify(slices)).toContain(PARENT_BODY);
  });

  // Defence in depth behind the query filter above: hydration re-checks post ACL
  // per viewer, and its unpublished guard can only fire on a record that
  // actually CARRIES `status`.
  it('hands the parent to hydration with its status, so the unpublished guard is not inert', async () => {
    const parent = await seedParent('published');
    const reply = await seedReply(parent.id);

    const { slices } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: false,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    const emitted = slices
      .flatMap((slice) => slice.items)
      .map((item) => item.post as unknown as { id: string; status?: string })
      .find((post) => post.id === parent.id);

    expect(emitted).toBeDefined();
    expect(emitted?.status).toBe('published');
  });
});
