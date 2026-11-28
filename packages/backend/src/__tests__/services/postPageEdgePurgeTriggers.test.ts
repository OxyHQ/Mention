/**
 * Every write that takes a post page off the public web, or changes it, asks
 * for that page to leave Cloudflare's edge — against real rows, with the purge
 * itself as the seam (`postPageEdgePurge.test.ts` covers what it then does).
 *
 * The triggers: a deletion (with the replies and boosts it removes), a
 * moderation restriction, a merged federated edit, an author's account being
 * erased or a channel deleted, and an author Mention no longer shows (swept
 * over their posts). A native edit, an Oxy account change and a profile made
 * private have suites of their own, beside the harnesses they need.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decisionFixture } from '@crowdsource.you/core/testing';

const mocks = vi.hoisted(() => ({
  purgePostPages: vi.fn(),
  scheduleAuthorPostPagePurge: vi.fn(),
  authorSeoPolicy: vi.fn(),
  invalidatePostDetail: vi.fn(),
}));

vi.mock('../../services/webshell/postPageEdgePurge', () => ({
  purgePostPages: mocks.purgePostPages,
  scheduleAuthorPostPagePurge: mocks.scheduleAuthorPostPagePurge,
}));
vi.mock('../../services/posts/postDetailCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/posts/postDetailCache')>()),
  invalidate: mocks.invalidatePostDetail,
}));
vi.mock('../../services/webshell/postPageAuthorPolicy', () => ({
  authorSeoPolicy: mocks.authorSeoPolicy,
}));
// A deleted public post federates its Delete; nothing here is about that.
vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: vi.fn(),
}));

import { PostType, PostVisibility } from '@mention/shared-types';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { moderationEnforcements } from '../../db/schema/moderation';
import { deleteAuthoredPost } from '../../services/posts/PostDeletionService';
import { applyDecisionEnforcement } from '../../services/moderation/ModerationEnforcementService';
import { eraseAccountPosts } from '../../services/accounts/accountErasure/erasePosts';
import { deleteBatchPosts } from '../../services/accounts/channelDeletion/channelCascadeQueries';
import { absorbTransportCopy } from '../../connectors/shared/transportCopies';
import { runAuthorPostPagePurge } from '../../services/webshell/authorPostPagePurge';
import { findDependentPostIds } from '../../services/webshell/postPageDependents';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';

const scope = serviceScope('edge-purge-triggers');
const usedDecisionIds: string[] = [];

/** The post ids of every `purgePostPages` call with this reason, flattened. */
function purgedFor(reason: string): string[] {
  return mocks.purgePostPages.mock.calls
    .filter(([, why]) => why === reason)
    .flatMap(([ids]) => ids as string[]);
}

beforeAll(() => connectPostgres());
afterAll(() => closePostgres());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.purgePostPages.mockResolvedValue(undefined);
  mocks.invalidatePostDetail.mockResolvedValue(undefined);
  mocks.authorSeoPolicy.mockResolvedValue({ visible: false, indexable: false });
});
afterEach(async () => {
  await clearServiceScope(scope);
  while (usedDecisionIds.length > 0) {
    const id = usedDecisionIds.pop() as string;
    await getDb().delete(moderationEnforcements).where(eq(moderationEnforcements.decisionId, id));
  }
});

describe('a deletion', () => {
  it('purges the deleted post and the reply that went with it, after the commit', async () => {
    const author = scope.user('author');
    const post = await seedPost(scope, { oxyUserId: author });
    const reply = await seedPost(scope, {
      oxyUserId: scope.user('replier'),
      parentPostId: post.id,
      threadId: post.id,
      isReply: true,
    });

    const deleted = await deleteAuthoredPost(post.id, author);

    expect(deleted).not.toBeNull();
    expect(await readPost(post.id)).toBeNull();
    expect(purgedFor('delete').sort()).toEqual([post.id, reply.id].sort());
  });

  it('purges the surviving pages that repeated the deleted post', async () => {
    const author = scope.user('author');
    const parent = await seedPost(scope, { oxyUserId: scope.user('parent-author') });
    const reply = await seedPost(scope, {
      oxyUserId: author,
      parentPostId: parent.id,
      threadId: parent.id,
      isReply: true,
    });
    const quote = await seedPost(scope, {
      oxyUserId: scope.user('quoter'),
      type: PostType.QUOTE,
      quoteOf: reply.id,
    });

    await deleteAuthoredPost(reply.id, author);

    expect(purgedFor('delete').sort()).toEqual([reply.id, parent.id, quote.id].sort());
  });

  it('purges nothing when the claim matches no row', async () => {
    const post = await seedPost(scope, { oxyUserId: scope.user('author') });

    expect(await deleteAuthoredPost(post.id, scope.user('someone-else'))).toBeNull();
    expect(mocks.purgePostPages).not.toHaveBeenCalled();
  });
});

describe('a moderation decision', () => {
  it('purges a post it restricts', async () => {
    const post = await seedPost(scope);
    const decision = { ...decisionFixture({ outcome: 'violation' }), id: `dec_${randomUUID()}` };
    usedDecisionIds.push(decision.id);

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: post.id },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect((await readPost(post.id))?.status).toBe('restricted');
    expect(purgedFor('moderation')).toEqual([post.id]);
  });

  it('still purges the page when the record cache cannot be evicted', async () => {
    mocks.invalidatePostDetail.mockRejectedValue(new Error('Redis gone'));
    const post = await seedPost(scope);
    const decision = { ...decisionFixture({ outcome: 'violation' }), id: `dec_${randomUUID()}` };
    usedDecisionIds.push(decision.id);

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: post.id },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect(mocks.invalidatePostDetail).toHaveBeenCalledWith(post.id);
    expect(purgedFor('moderation')).toEqual([post.id]);
  });

  it('purges nothing when the decision is only observed', async () => {
    const post = await seedPost(scope);
    const decision = { ...decisionFixture({ outcome: 'violation' }), id: `dec_${randomUUID()}` };
    usedDecisionIds.push(decision.id);

    await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: post.id },
      mode: 'observe',
    });

    expect(mocks.purgePostPages).not.toHaveBeenCalled();
  });
});

describe('a federated edit merged from another transport copy', () => {
  const incoming = (text: string) => ({
    objectUri: `https://bridge.example/notes/${randomUUID()}`,
    actorUri: 'https://bridge.example/users/someone',
    facts: { rank: 1 as const, text, media: [], sensitive: false },
    content: { variants: [{ source: 'author' as const, text, tag: 'en' }] },
    mentions: [],
  });

  it('purges a public post the edit changed', async () => {
    const post = await seedPost(scope);
    expect(await absorbTransportCopy(post.id, incoming('edited body'), { edited: true })).toBe(
      true,
    );
    expect(purgedFor('edit')).toEqual([post.id]);
  });

  it('does not purge for a copy merged at ingest', async () => {
    const post = await seedPost(scope);
    await absorbTransportCopy(post.id, incoming('another copy'));
    expect(mocks.purgePostPages).not.toHaveBeenCalled();
  });
});

describe('an erased account', () => {
  it('purges every post of the account, batch by batch', async () => {
    const erased = scope.user('erased');
    const first = await seedPost(scope, { oxyUserId: erased });
    const second = await seedPost(scope, { oxyUserId: erased });

    const result = await eraseAccountPosts(erased, null);

    expect(result.posts).toBe(2);
    expect(purgedFor('author_erased').sort()).toEqual([first.id, second.id].sort());
  });

  it('finds the boosts, quotes and parent that repeat a post', async () => {
    const parent = await seedPost(scope);
    const post = await seedPost(scope, {
      parentPostId: parent.id,
      threadId: parent.id,
      isReply: true,
    });
    const boost = await seedPost(scope, {
      oxyUserId: scope.user('booster'),
      type: PostType.REPOST,
      boostOf: post.id,
      content: { variants: [] },
    });
    const quote = await seedPost(scope, {
      oxyUserId: scope.user('quoter'),
      type: PostType.QUOTE,
      quoteOf: post.id,
    });

    expect((await findDependentPostIds([post.id])).sort()).toEqual(
      [parent.id, boost.id, quote.id].sort(),
    );
  });

  it('purges a deleted channel’s posts', async () => {
    const channelPost = await seedPost(scope, { oxyUserId: scope.user('channel') });
    const row = {
      id: channelPost.id,
      oxyUserId: channelPost.oxyUserId,
      parentPostId: null,
      federationActivityId: null,
      federationUrl: null,
      visibility: 'public',
    };

    await deleteBatchPosts(
      { channelPosts: [row], boosts: [], rows: [row], lastId: channelPost.id } as never,
      false,
    );

    expect(purgedFor('author_erased')).toEqual([channelPost.id]);
  });
});

describe('an author Mention no longer shows', () => {
  it('sweeps their public posts and the public boosts of them, and nothing else', async () => {
    const hidden = scope.user('hidden');
    const shown = await seedPost(scope, { oxyUserId: hidden });
    await seedPost(scope, { oxyUserId: hidden, visibility: PostVisibility.FOLLOWERS_ONLY });
    await seedPost(scope, { oxyUserId: hidden, status: 'draft' });
    const boost = await seedPost(scope, {
      oxyUserId: scope.user('booster'),
      type: PostType.REPOST,
      boostOf: shown.id,
      content: { variants: [] },
    });

    const { swept } = await runAuthorPostPagePurge(hidden);

    expect(mocks.authorSeoPolicy).toHaveBeenCalledWith(hidden);
    expect(swept).toBe(2);
    expect(mocks.purgePostPages).toHaveBeenCalledWith(
      expect.arrayContaining([shown.id, boost.id]),
      'author_hidden',
      { priority: 'sweep' },
    );
    expect(purgedFor('author_hidden')).toHaveLength(2);
  });

  it('sweeps nothing when the page would still show them', async () => {
    const visible = scope.user('visible');
    await seedPost(scope, { oxyUserId: visible });
    mocks.authorSeoPolicy.mockResolvedValue({ visible: true, indexable: true });

    expect(await runAuthorPostPagePurge(visible)).toEqual({ swept: 0 });
    expect(mocks.purgePostPages).not.toHaveBeenCalled();
  });

  it('does not ask Oxy about an author with no public post', async () => {
    expect(await runAuthorPostPagePurge(scope.user('no-posts'))).toEqual({ swept: 0 });
    expect(mocks.authorSeoPolicy).not.toHaveBeenCalled();
  });
});
