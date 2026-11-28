/**
 * A purge that fails never fails the action that asked for it.
 *
 * The REAL purge module, switched on, in front of a queue that refuses every
 * job (Redis gone) and a Cloudflare that answers 503. A deletion, a moderation
 * restriction and an erasure still complete and commit; what is left is the
 * logged line the alarm watches.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decisionFixture } from '@crowdsource.you/core/testing';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../queue/producers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../queue/producers')>()),
  enqueuePostPageEdgePurge: mocks.enqueue,
}));
vi.mock('../../connectors/outboundFederation', () => ({ federateAsResolvedActor: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { error: mocks.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    config: { ...actual.config, edgePurge: { enabled: true, zoneId: '0'.repeat(32) } },
    getCloudflarePurgeToken: () => 'test-purge-token',
  };
});

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { moderationEnforcements } from '../../db/schema/moderation';
import { deleteAuthoredPost } from '../../services/posts/PostDeletionService';
import { applyDecisionEnforcement } from '../../services/moderation/ModerationEnforcementService';
import { eraseAccountPosts } from '../../services/accounts/accountErasure/erasePosts';
import { POST_PAGE_PURGE_GAVE_UP_LOG } from '../../services/webshell/postPageEdgePurge';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';

const scope = serviceScope('edge-purge-resilience');
const usedDecisionIds: string[] = [];
const fetchMock = vi.fn();

function gaveUp(): unknown[] {
  return mocks.error.mock.calls.filter(([line]) => line === POST_PAGE_PURGE_GAVE_UP_LOG);
}

beforeAll(() => connectPostgres());
afterAll(() => closePostgres());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response('{"success":false,"errors":[]}', { status: 503 }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await clearServiceScope(scope);
  while (usedDecisionIds.length > 0) {
    const id = usedDecisionIds.pop() as string;
    await getDb().delete(moderationEnforcements).where(eq(moderationEnforcements.decisionId, id));
  }
});

describe.each([
  [
    'the queue refuses the job',
    () => {
      mocks.enqueue.mockRejectedValue(new Error('Redis gone'));
    },
  ],
  [
    'there is no queue and Cloudflare fails',
    () => {
      mocks.enqueue.mockResolvedValue(false);
    },
  ],
])('when %s', (_label, arrange) => {
  beforeEach(() => {
    arrange();
  });

  it('a deletion still completes', async () => {
    const author = scope.user('author');
    const post = await seedPost(scope, { oxyUserId: author });

    await expect(deleteAuthoredPost(post.id, author)).resolves.not.toBeNull();
    expect(await readPost(post.id)).toBeNull();
    await vi.waitFor(() => expect(gaveUp().length).toBeGreaterThan(0));
  });

  it('a moderation restriction still applies', async () => {
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
    await vi.waitFor(() => expect(gaveUp().length).toBeGreaterThan(0));
  });

  it('an erasure still removes every post', async () => {
    const erased = scope.user('erased');
    await seedPost(scope, { oxyUserId: erased });

    await expect(eraseAccountPosts(erased, null)).resolves.toMatchObject({ posts: 1 });
    await vi.waitFor(() => expect(gaveUp().length).toBeGreaterThan(0));
  });
});
