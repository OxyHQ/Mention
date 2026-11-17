/**
 * A jury's `legal_queue` is carried out as a referral to Oxy (oxy ADR 0043 D14),
 * against a real Postgres with the referral itself stubbed.
 *
 * Three properties: it runs in EVERY enforcement mode, `observe` included,
 * because it does nothing to content; it leaves the post exactly as it was; and a
 * referral that fails releases its claim, so the retry refers again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decisionFixture } from '@crowdsource.you/core/testing';

const referSubjectForChildSafety = vi.fn();
vi.mock('../../../services/moderation/ContentReferralWorker', () => ({
  referSubjectForChildSafety: (...args: unknown[]) => referSubjectForChildSafety(...args),
}));

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { moderationEnforcements } from '../../../db/schema/moderation';
import { posts } from '../../../db/schema/posts';
import { uuidv7 } from '@oxy.so/db';
import { applyDecisionEnforcement } from '../../../services/moderation/ModerationEnforcementService';

let db: Database;
const createdPostIds: string[] = [];
const usedDecisionIds: string[] = [];

async function createPost(): Promise<string> {
  const id = uuidv7();
  await db.insert(posts).values({ id, oxyUserId: 'oxy-referral-author', status: 'published' });
  createdPostIds.push(id);
  return id;
}

function legalQueueDecision() {
  const decision = {
    ...decisionFixture({ outcome: 'escalated' }),
    id: `dec_${randomUUID()}`,
    recommendedActions: [{ action: 'legal_queue' }],
  };
  usedDecisionIds.push(decision.id);
  return decision as ReturnType<typeof decisionFixture>;
}

async function rows(decisionId: string) {
  return db
    .select()
    .from(moderationEnforcements)
    .where(eq(moderationEnforcements.decisionId, decisionId));
}

async function statusOf(postId: string) {
  const [row] = await db.select({ status: posts.status }).from(posts).where(eq(posts.id, postId));
  return row?.status;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  referSubjectForChildSafety.mockReset();
  for (const decisionId of usedDecisionIds.splice(0)) {
    await db
      .delete(moderationEnforcements)
      .where(eq(moderationEnforcements.decisionId, decisionId));
  }
  for (const id of createdPostIds.splice(0)) await db.delete(posts).where(eq(posts.id, id));
});

afterAll(async () => {
  await closePostgres();
});

describe('a legal_queue recommendation', () => {
  it.each(['observe', 'manual', 'automatic'] as const)(
    'refers the content in %s mode, and leaves the post as it was',
    async (mode) => {
      referSubjectForChildSafety.mockResolvedValue({ referred: true, reference: 'OXY-7K3M-9Q2D' });
      const postId = await createPost();
      const decision = legalQueueDecision();

      const outcomes = await applyDecisionEnforcement({
        decision,
        caseId: decision.caseId,
        subject: { type: 'post', id: postId },
        mode,
      });

      expect(outcomes).toEqual([{ action: 'legal_referral', result: 'applied' }]);
      expect(referSubjectForChildSafety).toHaveBeenCalledTimes(1);
      expect(referSubjectForChildSafety).toHaveBeenCalledWith({ type: 'post', id: postId });
      expect(await statusOf(postId)).toBe('published');

      const [row] = await rows(decision.id);
      expect(row).toMatchObject({
        action: 'legal_referral',
        recommendedAction: 'legal_queue',
        applied: true,
        skippedReason: null,
        previousStatePostStatus: null,
      });
    },
  );

  it('refers once however many times the decision is delivered', async () => {
    referSubjectForChildSafety.mockResolvedValue({ referred: true, reference: 'OXY-7K3M-9Q2D' });
    const postId = await createPost();
    const decision = legalQueueDecision();
    const input = {
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: postId },
      mode: 'observe' as const,
    };

    await applyDecisionEnforcement(input);
    const redelivered = await applyDecisionEnforcement(input);

    expect(redelivered).toEqual([{ action: 'legal_referral', result: 'duplicate' }]);
    expect(referSubjectForChildSafety).toHaveBeenCalledTimes(1);
  });

  it('records why, when there was nothing to refer', async () => {
    referSubjectForChildSafety.mockResolvedValue({
      referred: false,
      reason: 'The reported content no longer exists',
    });
    const decision = legalQueueDecision();

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: uuidv7() },
      mode: 'observe',
    });

    expect(outcomes).toEqual([{ action: 'legal_referral', result: 'recorded' }]);
    const [row] = await rows(decision.id);
    expect(row).toMatchObject({
      applied: false,
      skippedReason: 'The reported content no longer exists',
    });
  });

  it('releases its claim when the referral fails, so the retry refers', async () => {
    referSubjectForChildSafety.mockRejectedValueOnce(new Error('Oxy is unavailable'));
    referSubjectForChildSafety.mockResolvedValue({ referred: true, reference: 'OXY-7K3M-9Q2D' });
    const postId = await createPost();
    const decision = legalQueueDecision();
    const input = {
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: postId },
      mode: 'observe' as const,
    };

    await expect(applyDecisionEnforcement(input)).rejects.toThrow('Oxy is unavailable');
    expect(await rows(decision.id)).toEqual([]);

    expect(await applyDecisionEnforcement(input)).toEqual([
      { action: 'legal_referral', result: 'applied' },
    ]);
    expect(referSubjectForChildSafety).toHaveBeenCalledTimes(2);
  });
});
