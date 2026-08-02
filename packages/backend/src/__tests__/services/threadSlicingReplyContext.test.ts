import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostVisibility, type PostUser } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Regression harness for the blank reply-context author bug (M9), plus the two
 * post-shaped invariants the slicer's OWN queries carry.
 *
 * A `replyContext` slice renders a "Replying to @<parent author>" header from
 * `slice.reason.parentAuthor`. Thread slicing runs on RAW post records BEFORE
 * `PostHydrationService` resolves authors, so the parent's canonical
 * `name.displayName` / handle / avatar are NOT present on the record (only
 * `oxyUserId` is). The old code read `parent.user` (undefined) and serialized
 * `displayName: ''` / `handle: ''` → the header rendered a bare "@".
 *
 * ## What changed with the Postgres port
 *
 * `fetchParentPosts` and `fetchThreadChildren` are real SQL now, and the suite
 * no longer stubs `models/Post`. That matters for more than tidiness: the old
 * self-thread test asserted the shape of the Mongo filter the slicer BUILT
 * (`parentPostId: { $ne: null, $exists: true }`), which cannot distinguish a
 * correct query from one that matches nothing — and this particular clause is
 * the one that does NOT translate literally, because Mongo's `$ne: null` also
 * matches a missing field while SQL's `<> NULL` is NULL and matches no row at
 * all. The rewrite seeds real children and asserts WHICH ones came back.
 *
 * `resolveUserSummaries` stays mocked: it is the Oxy identity boundary, not part
 * of this port, and mocking it keeps the author assertions about the slicer.
 */

const { resolveUserSummaries } = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

// Mock only the boundary the slicer depends on. `resolveUserSummaries` is the
// canonical, batched/Redis-cached author resolver exported by
// PostHydrationService.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { threadSlicingService } from '../../services/ThreadSlicingService';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = serviceScope('thread-slicing-reply-context');
const PARENT_AUTHOR_ID = scope.user('parent-author');
const REPLY_AUTHOR_ID = scope.user('reply-author');

function summary(id: string, username: string, displayName: string): CachedUserSummary {
  return {
    user: { id, username, name: { displayName }, avatar: `${id}-avatar`, verified: false },
    followerCount: 0,
  };
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

/** Seed a published, public parent owned by `PARENT_AUTHOR_ID`. */
function seedParent(text: string, oxyUserId = PARENT_AUTHOR_ID): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId,
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
  });
}

/** Seed a published, public reply to `parentId`. */
function seedReply(parentId: string, text: string): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: REPLY_AUTHOR_ID,
    parentPostId: parentId,
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
  });
}

describe('ThreadSlicingService reply-context parent author', () => {
  it('populates parentAuthor from the resolved canonical summary (not blank)', async () => {
    const parent = await seedParent('parent body');
    const reply = await seedReply(parent.id, 'a reply');
    resolveUserSummaries.mockResolvedValue(
      new Map<string, CachedUserSummary>([
        [PARENT_AUTHOR_ID, summary(PARENT_AUTHOR_ID, 'parenthandle', 'Parent Display Name')],
      ]),
    );

    // Only the REPLY is a feed candidate — the parent has to be fetched.
    const { slices } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: false,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    const replyContextSlice = slices.find((s) => s.reason?.type === 'replyContext');
    expect(replyContextSlice).toBeDefined();
    const reason = replyContextSlice?.reason;
    if (reason?.type !== 'replyContext') throw new Error('expected replyContext reason');

    expect(reason.parentAuthor).toBeDefined();
    const parentAuthor = reason.parentAuthor as PostUser;
    expect(parentAuthor.name.displayName).toBe('Parent Display Name');
    expect(parentAuthor.username).toBe('parenthandle');
    expect(parentAuthor.id).toBe(PARENT_AUTHOR_ID);

    // The parent POST itself came out of the database and was prepended.
    expect(replyContextSlice?._sliceKey).toBe(`${parent.id}+${reply.id}`);

    // The slicer must resolve the PARENT author id through the canonical path.
    expect(resolveUserSummaries).toHaveBeenCalledTimes(1);
    expect(resolveUserSummaries.mock.calls[0][0]).toContain(PARENT_AUTHOR_ID);
  });

  it('emits the degraded (ghost-handle-safe) parent author when it cannot be resolved', async () => {
    const parent = await seedParent('parent body');
    const reply = await seedReply(parent.id, 'a reply');
    // Author resolution returns nothing (e.g. Oxy lookup miss + no federated actor).
    resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());

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

  it('prepends the parent of EVERY reply on the page, not just the first', async () => {
    /**
     * Two replies to two DIFFERENT parents is the smallest case that shows a
     * fetched parent arriving without a usable `id`: `_sliceKey` would read
     * `"undefined+<reply>"`, `additionalPostIds` would hand hydration an
     * `undefined` id, and — because the `seenPostIds` guard then dedupes BOTH
     * parents against the single key `undefined` — the second reply silently
     * loses its "Replying to" context.
     */
    const firstParent = await seedParent('first parent');
    const secondParent = await seedParent('second parent', scope.user('second-parent-author'));
    const firstReply = await seedReply(firstParent.id, 'first reply');
    const secondReply = await seedReply(secondParent.id, 'second reply');

    const { slices, additionalPostIds } = await threadSlicingService.sliceFeed(
      [firstReply, secondReply],
      { enableThreadGrouping: false, enableReplyContext: true, maxSliceSize: 3 },
    );

    expect(slices.map((slice) => slice._sliceKey)).toEqual([
      `${firstParent.id}+${firstReply.id}`,
      `${secondParent.id}+${secondReply.id}`,
    ]);
    expect([...additionalPostIds].sort()).toEqual([firstParent.id, secondParent.id].sort());
  });

  it('never emits an unpublished parent as reply context', async () => {
    // A reply-context parent is injected into whatever feed the reply landed in,
    // so it must clear the same publication bar as every feed candidate. The
    // reply itself stays published — only the parent is a draft.
    const parent = await seedPost(scope, {
      oxyUserId: PARENT_AUTHOR_ID,
      status: 'draft',
      content: { variants: [{ source: 'author', text: 'the unpublished parent body', tag: 'en' }] },
    });
    const reply = await seedReply(parent.id, 'a public reply');

    const { slices, additionalPostIds } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: false,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    expect(slices.map((slice) => slice._sliceKey)).toEqual([reply.id]);
    expect(additionalPostIds).not.toContain(parent.id);
    // The slice still declares itself a reply — only the parent is withheld.
    expect(slices[0].reason?.type).toBe('replyContext');
  });

  it('injects a FOLLOWERS-ONLY parent, leaving the per-viewer ACL to hydration', async () => {
    // `visibility` is deliberately NOT filtered by the parent query: a
    // followers-only parent that a follower IS entitled to see must still reach
    // them, and hydration re-checks post ACL per viewer. Dropping the
    // publication filter and the visibility filter are two different changes and
    // this pins that only the first one exists.
    const parent = await seedPost(scope, {
      oxyUserId: PARENT_AUTHOR_ID,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      content: { variants: [{ source: 'author', text: 'followers-only parent', tag: 'en' }] },
    });
    const reply = await seedReply(parent.id, 'a reply to it');

    const { slices, additionalPostIds } = await threadSlicingService.sliceFeed([reply], {
      enableThreadGrouping: false,
      enableReplyContext: true,
      maxSliceSize: 3,
    });

    expect(slices.map((slice) => slice._sliceKey)).toEqual([`${parent.id}+${reply.id}`]);
    expect(additionalPostIds).toContain(parent.id);
  });

  it('hands the parent to hydration carrying its status, so the unpublished guard is not inert', async () => {
    // Defence in depth behind the query filter above: hydration re-checks post
    // ACL per viewer, and its unpublished guard reads `post.status ?? 'published'`
    // — a parent that reaches it without the field defaults to published and the
    // guard never fires.
    const parent = await seedParent('parent body');
    const reply = await seedReply(parent.id, 'a reply');

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

/**
 * A federated reply is linked into its thread only if the outbox connector can
 * resolve — or bounded-backfill — its parent (`outbox.service.ts`,
 * `if (!link) continue`). When the parent is unreachable the reply is stored
 * with `federation.inReplyTo` intact and `parent_post_id` left NULL.
 *
 * The slicer used to test `post.parentPostId` and therefore classified those as
 * thread ROOTS: no `replyContext` reason, so the renderer's "Replying to" header
 * never fired and the `hideReplies` tuner (which filters on that same reason)
 * never saw them either. A context-free reply — "@someone thank you!" — rendered
 * as an ordinary top-level post.
 */
describe('ThreadSlicingService replies without a local parent link', () => {
  it('tags an unlinked federated reply as replyContext, with no parentAuthor', async () => {
    const reply = await seedPost(scope, {
      oxyUserId: REPLY_AUTHOR_ID,
      // `is_reply` is STORED and is true precisely because `federation.inReplyTo`
      // is the only encoding of the parent this post has.
      federation: { inReplyTo: 'https://remote.example/users/someone/statuses/1' },
      content: { variants: [{ source: 'author', text: '@someone thank you!', tag: 'en' }] },
    });
    expect(reply.isReply).toBe(true);
    expect(reply.parentPostId).toBeNull();

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
  });

  it('does not treat an unlinked federated reply as a self-thread root', async () => {
    // A stale/backfilled threadId must not promote a reply to a thread root.
    const root = await seedPost(scope, {
      oxyUserId: REPLY_AUTHOR_ID,
      content: { variants: [{ source: 'author', text: 'thread anchor', tag: 'en' }] },
    });
    const reply = await seedPost(scope, {
      oxyUserId: REPLY_AUTHOR_ID,
      threadId: root.id,
      federation: { inReplyTo: 'https://remote.example/users/someone/statuses/1' },
      content: { variants: [{ source: 'author', text: 'a federated reply', tag: 'en' }] },
    });
    expect(reply.isReply).toBe(true);

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
    const parent = await seedParent('parent body');
    const reply = await seedReply(parent.id, 'a reply');

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
  it('groups only the PUBLIC, PUBLISHED, same-author children that carry a parent link', async () => {
    /**
     * Four rejects, one accept, all sharing the root's `thread_id` — the whole
     * `fetchThreadChildren` predicate stated as data rather than as the shape of
     * a query object.
     *
     * The `parent_post_id IS NOT NULL` clause is the one worth the seed: Mongo's
     * `$ne: null` ALSO matched a missing field, and the literal SQL translation
     * (`<> NULL`) is NULL for every row and returns nothing at all — so a suite
     * that only asserted the filter was built could not tell the correct query
     * from one that un-threads every self-thread in the feed.
     */
    const author = scope.user('thread-author');
    const root = await seedPost(scope, {
      oxyUserId: author,
      content: { variants: [{ source: 'author', text: 'public root', tag: 'en' }] },
    });
    // Anchor the thread on the root's own id, exactly as `createThread` does.
    const rootWithThread = { ...root, threadId: root.id };

    const child = await seedPost(scope, {
      oxyUserId: author,
      parentPostId: root.id,
      threadId: root.id,
      content: { variants: [{ source: 'author', text: 'the one real continuation', tag: 'en' }] },
    });
    await seedPost(scope, {
      oxyUserId: author,
      parentPostId: root.id,
      threadId: root.id,
      status: 'draft',
      content: { variants: [{ source: 'author', text: 'draft continuation', tag: 'en' }] },
    });
    await seedPost(scope, {
      oxyUserId: author,
      parentPostId: root.id,
      threadId: root.id,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      content: { variants: [{ source: 'author', text: 'followers-only continuation', tag: 'en' }] },
    });
    await seedPost(scope, {
      oxyUserId: scope.user('someone-else'),
      parentPostId: root.id,
      threadId: root.id,
      content: { variants: [{ source: 'author', text: 'another author in the thread', tag: 'en' }] },
    });
    // Same thread, same author, NO parent link — a sibling root, not a
    // continuation. This is the row the `$ne: null` translation gets wrong.
    await seedPost(scope, {
      oxyUserId: author,
      threadId: root.id,
      content: { variants: [{ source: 'author', text: 'parentless same-thread post', tag: 'en' }] },
    });

    const { slices, additionalPostIds } = await threadSlicingService.sliceFeed([rootWithThread], {
      enableThreadGrouping: true,
      enableReplyContext: false,
      maxSliceSize: 3,
    });

    // Exactly one continuation joined the root — not zero (the SQL translation
    // trap) and not four (a predicate that dropped a clause). Asserted on the
    // BODIES rather than on ids, so a failure names the row that leaked in
    // instead of printing two nearly identical uuid concatenations.
    expect(slices).toHaveLength(1);
    expect(
      slices[0].items.map(
        (item) => (item.post as unknown as { content: { variants?: Array<{ text: string }> } })
          .content.variants?.[0]?.text,
      ),
    ).toEqual(['public root', 'the one real continuation']);
    expect(slices[0]._sliceKey).toBe(`${root.id}+${child.id}`);
    expect(slices[0].reason?.type).toBe('selfThread');
    expect(additionalPostIds).toEqual([child.id]);
  });

  it('caps a slice at maxSliceSize, fetching no more children than can fit', async () => {
    // `fetchThreadChildren` limits itself to `roots × (maxSliceSize - 1)`, so
    // with one root it never reads a child the slice could not hold. That is why
    // `isIncompleteThread` stays FALSE here even though two continuations were
    // left behind: the flag compares the children it FETCHED against the ones it
    // placed, and those are equal by construction on a single-root page. Pinned
    // as observed behaviour, not endorsed — a caller wanting a truthful "there
    // is more" marker has to overfetch by one.
    const author = scope.user('long-thread-author');
    const root = await seedPost(scope, {
      oxyUserId: author,
      content: { variants: [{ source: 'author', text: 'root of a long thread', tag: 'en' }] },
    });
    for (const n of [1, 2, 3, 4]) {
      await seedPost(scope, {
        oxyUserId: author,
        parentPostId: root.id,
        threadId: root.id,
        content: { variants: [{ source: 'author', text: `continuation ${n}`, tag: 'en' }] },
      });
    }

    const { slices, additionalPostIds } = await threadSlicingService.sliceFeed(
      [{ ...root, threadId: root.id }],
      { enableThreadGrouping: true, enableReplyContext: false, maxSliceSize: 3 },
    );

    expect(slices).toHaveLength(1);
    expect(slices[0].items).toHaveLength(3);
    // Only the two children that fit were read, so only two extra ids are handed
    // to hydration — the cap is enforced at the QUERY, not by trimming after.
    expect(additionalPostIds).toHaveLength(2);
    expect(slices[0].isIncompleteThread).toBe(false);
  });
});
