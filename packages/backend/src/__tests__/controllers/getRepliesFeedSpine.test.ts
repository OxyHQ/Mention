/**
 * {@link FeedController.getRepliesFeed}'s self-thread spine expansion
 * (Bluesky-style replies), against REAL ROWS.
 *
 * When the parent post is a self-thread ROOT (`threadId === <its own id>`), the
 * replies feed must surface external replies to ANY node of the OP's
 * continuation spine (root … cN), not just the root's direct children — while
 * EXCLUDING the OP's own continuations, which the client renders as the
 * connected spine. For any other parent the query is the single-parent match.
 *
 * The previous version spied on `Post.find` and asserted the FILTER OBJECT the
 * controller built. That is exactly the check that cannot fail for the right
 * reason: it passed whether or not the filter selected anything, and it pinned
 * the Mongo spelling of a query that has since become SQL, so it would have gone
 * red on a correct port and green on a broken one. The rows are real now and the
 * assertions are about which replies come back.
 *
 * Hydration stays stubbed to a passthrough: it resolves authors through Oxy,
 * which is a remote service, and the spine selection happens entirely before it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: vi.fn(async (records: Array<{ id: string; oxyUserId: string }>) =>
      records.map((record) => ({ ...record, user: { id: record.oxyUserId } })),
    ),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

const privacyMocks = vi.hoisted(() => ({
  loadPrivacyState: vi.fn(async () => ({ excludedUserIds: new Set() })),
}));
vi.mock('../../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: { loadPrivacyState: privacyMocks.loadPrivacyState },
}));

const oxyMocks = vi.hoisted(() => ({
  scopedClient: {},
  createScopedOxyClient: vi.fn(),
}));
oxyMocks.createScopedOxyClient.mockReturnValue(oxyMocks.scopedClient);
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: oxyMocks.createScopedOxyClient,
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { feedController } from '../../controllers/feed.controller';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = postScope('replies-spine');
const OP = scope.user('op');
const OTHER = scope.user('other');

interface FeedPayload {
  items: Array<{ id: string }>;
  hasMore?: boolean;
  nextCursor?: string | null;
}

function buildResponse() {
  const payload: { value?: FeedPayload; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: unknown) {
      payload.value = body as FeedPayload;
      return this;
    },
  };
  return { res, payload };
}

async function fetchReplies(
  parentId: string,
  query: Record<string, string> = {},
): Promise<FeedPayload> {
  const { res, payload } = buildResponse();
  await feedController.getRepliesFeed(
    {
      query,
      params: { parentId },
      user: { id: 'viewer' },
      headers: { authorization: 'Bearer viewer-token' },
    } as never,
    res as never,
  );
  if (!payload.value) throw new Error('handler produced no response body');
  return payload.value;
}

/**
 * A self-thread: `root` anchors its own id as `threadId`, and each continuation
 * hangs off the previous node. That chain is what spine expansion walks.
 */
async function seedSelfThread(): Promise<{ root: PostRecord; c1: PostRecord; c2: PostRecord }> {
  const seeded = await seedPost(scope, { oxyUserId: OP });
  // The root anchors its OWN id, which `createThread` can only do after the
  // insert has minted one. Leaving it null is what makes a root look like an
  // ordinary post, so the update is the fixture's whole point rather than a
  // detail: without it `isSelfThreadRoot` is false and nothing expands.
  await getDb().update(posts).set({ threadId: seeded.id }).where(eq(posts.id, seeded.id));
  const root = { ...seeded, threadId: seeded.id };
  const c1 = await seedPost(scope, {
    oxyUserId: OP,
    threadId: root.id,
    parentPostId: root.id,
    isReply: true,
  });
  const c2 = await seedPost(scope, {
    oxyUserId: OP,
    threadId: root.id,
    parentPostId: c1.id,
    isReply: true,
  });
  return { root, c1, c2 };
}

describe('getRepliesFeed — self-thread spine expansion', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  afterEach(async () => {
    await clearPostScope(scope);
    vi.clearAllMocks();
    oxyMocks.createScopedOxyClient.mockReturnValue(oxyMocks.scopedClient);
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('surfaces external replies to ANY spine node and never the OP continuations', async () => {
    const { root, c1, c2 } = await seedSelfThread();
    const toRoot = await seedPost(scope, {
      oxyUserId: OTHER,
      parentPostId: root.id,
      isReply: true,
    });
    const toC1 = await seedPost(scope, { oxyUserId: OTHER, parentPostId: c1.id, isReply: true });
    const toC2 = await seedPost(scope, { oxyUserId: OTHER, parentPostId: c2.id, isReply: true });

    const ids = (await fetchReplies(root.id)).items.map((item) => item.id);

    expect(new Set(ids)).toEqual(new Set([toRoot.id, toC1.id, toC2.id]));
    // The continuations match the expanded parent filter and must be excluded by
    // id — that exclusion is the only thing keeping the spine out of the replies.
    expect(ids).not.toContain(c1.id);
    expect(ids).not.toContain(c2.id);
    expect(privacyMocks.loadPrivacyState).toHaveBeenCalledWith('viewer', {
      oxyClient: oxyMocks.scopedClient,
    });
  });

  it('pages the expanded spine without skipping or repeating a reply', async () => {
    const { root, c1 } = await seedSelfThread();
    const replies: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const reply = await seedPost(scope, {
        oxyUserId: OTHER,
        parentPostId: index % 2 === 0 ? root.id : c1.id,
        isReply: true,
      });
      replies.push(reply.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const body = await fetchReplies(root.id, { limit: '2', ...(cursor ? { cursor } : {}) });
      seen.push(...body.items.map((item) => item.id));
      if (!body.hasMore || !body.nextCursor) break;
      cursor = body.nextCursor;
      if ((guard += 1) > 6) throw new Error('pagination did not terminate');
    }

    expect(new Set(seen)).toEqual(new Set(replies));
    expect(seen).toHaveLength(replies.length);
  });

  it('leaves a mid-thread continuation as a single-parent query (no spine)', async () => {
    const { root, c1, c2 } = await seedSelfThread();
    const toC1 = await seedPost(scope, { oxyUserId: OTHER, parentPostId: c1.id, isReply: true });
    await seedPost(scope, { oxyUserId: OTHER, parentPostId: root.id, isReply: true });

    // `c1.threadId` points at the ROOT, not at itself, so it is not a root: no
    // spine expansion, and the OP's own next continuation is therefore an
    // ORDINARY reply to `c1` rather than something to exclude. The reply to the
    // root does not appear, which is what "single-parent" means here.
    const ids = (await fetchReplies(c1.id)).items.map((item) => item.id);

    expect(new Set(ids)).toEqual(new Set([toC1.id, c2.id]));
  });

  it('treats a post with no threadId as a plain post (single-parent query)', async () => {
    const plain = await seedPost(scope, { oxyUserId: OP });
    const reply = await seedPost(scope, {
      oxyUserId: OTHER,
      parentPostId: plain.id,
      isReply: true,
    });
    // A reply to the reply must NOT surface: there is no spine to expand.
    await seedPost(scope, { oxyUserId: OTHER, parentPostId: reply.id, isReply: true });

    const ids = (await fetchReplies(plain.id)).items.map((item) => item.id);

    expect(ids).toEqual([reply.id]);
  });

  it('returns an empty page for an unknown parent instead of failing', async () => {
    const body = await fetchReplies('019fffff-ffff-7fff-bfff-ffffffffffff');

    expect(body.items).toEqual([]);
  });
});
