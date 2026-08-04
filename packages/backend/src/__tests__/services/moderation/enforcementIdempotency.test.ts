/**
 * A redelivered decision enforces exactly once (Appendix D) — and a decision
 * about a real post is CARRIED OUT rather than silently skipped.
 *
 * §10.9 retries a delivery six times over 24 hours, and a retry also happens when
 * the receiver's 2xx was simply lost. So the same decision WILL arrive twice at a
 * healthy deployment, and the only thing standing between that and a post being
 * removed twice — or, worse, a correction restoring it twice and undoing a later
 * legitimate removal — is the unique key on `decisionId + revision + action`.
 *
 * ## Why this runs against a real database
 *
 * The previous version of this file drove an in-memory fake and mocked
 * `Post.findById` / `Post.updateOne`, so it asserted that the service ISSUED the
 * right calls and never that a row ended up right. That is precisely the shape
 * that let `loadPostState`'s `isValidObjectId` guard survive: a mocked
 * `Post.findById` returns the post regardless of what the id looks like, so the
 * guard was never on any path a test could reach, and every enforcement against
 * a non-ObjectId id was a no-op in production that no assertion could see.
 *
 * So: real rows, real constraint, real `posts.status`. `decisionId` is unique per
 * test because the idempotency key is global — two tests sharing one would
 * deduplicate each other.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { decisionFixture } from '@oxyhq/crowdsource-testing';

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { moderationEnforcements } from '../../../db/schema/moderation';
import { posts } from '../../../db/schema/posts';
import { uuidv7 } from '../../../db/schema/columns';
import { applyDecisionEnforcement } from '../../../services/moderation/ModerationEnforcementService';
import { planEnforcement } from '../../../services/moderation/enforcementPlan';

let db: Database;
const createdPostIds: string[] = [];
const usedDecisionIds: string[] = [];

/**
 * A post row, with the id shape under test.
 *
 * `id` is passed EXPLICITLY rather than left to the column default so a case can
 * pin the shape it is about — a pre-cutover 24-char ObjectId hex, or the uuid v7
 * every post created after the cutover carries.
 */
async function createPost(
  id: string,
  overrides: { status?: 'draft' | 'published' | 'restricted'; metadataIsSensitive?: boolean } = {},
): Promise<string> {
  await db.insert(posts).values({
    id,
    oxyUserId: 'oxy-enforcement-author',
    status: overrides.status ?? 'published',
    metadataIsSensitive: overrides.metadataIsSensitive ?? false,
  });
  createdPostIds.push(id);
  return id;
}

/** A 24-char ObjectId hex, the shape every pre-cutover post id has. */
function objectIdHex(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

async function readPost(id: string) {
  const [row] = await db
    .select({ status: posts.status, metadataIsSensitive: posts.metadataIsSensitive })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1);
  return row;
}

/** Enforcement rows for one decision, oldest first. */
async function enforcementRows(decisionId: string) {
  return await db
    .select()
    .from(moderationEnforcements)
    .where(eq(moderationEnforcements.decisionId, decisionId))
    .orderBy(moderationEnforcements.createdAt, moderationEnforcements.id);
}

/** A decision fixture whose id is unique to this test run. */
function uniqueDecision(options: Parameters<typeof decisionFixture>[0]) {
  const decision = { ...decisionFixture(options), id: `dec_${randomUUID()}` };
  usedDecisionIds.push(decision.id);
  return decision;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (usedDecisionIds.length > 0) {
    const decisionId = usedDecisionIds.pop();
    if (decisionId) {
      await db
        .delete(moderationEnforcements)
        .where(eq(moderationEnforcements.decisionId, decisionId));
    }
  }
  while (createdPostIds.length > 0) {
    const id = createdPostIds.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('enforcement — a decision about a real post is actually carried out', () => {
  /**
   * THE regression test for the fail-open guard.
   *
   * `loadPostState` used to answer `null` for any id that was not 24-char hex,
   * and the caller reads `null` as "the reported post no longer exists". Every
   * post created after the cutover carries a uuid v7, so reinstating that guard
   * turns EVERY CrowdSource enforcement into a silent no-op — recorded, with a
   * plausible reason, while the post stays up.
   *
   * Both assertions below go red under the guard: the outcome degrades from
   * `applied` to `recorded`, and the post keeps `status: 'published'`.
   */
  it('restricts a post whose id is a uuid v7, rather than reporting it does not exist', async () => {
    const postId = await createPost(uuidv7());
    const decision = uniqueDecision({ outcome: 'violation' });

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: postId },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect((await readPost(postId))?.status).toBe('restricted');

    const [row] = await enforcementRows(decision.id);
    expect(row.applied).toBe(true);
    expect(row.skippedReason).toBeNull();
  });

  it('restricts a post whose id is a pre-cutover ObjectId hex', async () => {
    const postId = await createPost(objectIdHex());
    const decision = uniqueDecision({ outcome: 'violation' });

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: postId },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect((await readPost(postId))?.status).toBe('restricted');
  });

  it('still reports a genuinely absent post as absent', async () => {
    /**
     * The counterpart that keeps the test above from passing vacuously: removing
     * the guard must not make "no such post" unreachable. A malformed id lands
     * here too — it matches no row, which is the same true answer.
     */
    const decision = uniqueDecision({ outcome: 'violation' });

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: 'not-an-id-of-any-shape' },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'recorded' }]);
    const [row] = await enforcementRows(decision.id);
    expect(row.applied).toBe(false);
    expect(row.skippedReason).toBe('The reported post no longer exists');
  });

  it('applies a content warning to a uuid-v7 post', async () => {
    const postId = await createPost(uuidv7());
    const decision = {
      ...uniqueDecision({ outcome: 'violation' }),
      recommendedActions: [{ action: 'allow_with_label' as const }],
    };

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: postId },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'label_sensitive', result: 'applied' }]);
    expect((await readPost(postId))?.metadataIsSensitive).toBe(true);
  });
});

describe('enforcement — idempotent on decisionId + revision + action', () => {
  it('removes a post once, however many times the decision is delivered', async () => {
    const postId = await createPost(uuidv7());
    const decision = uniqueDecision({ outcome: 'violation' });
    const subject = { type: 'post', id: postId };

    const first = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject,
      mode: 'automatic',
    });
    expect(first).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect((await readPost(postId))?.status).toBe('restricted');

    // The redelivery §10.9 guarantees will happen.
    const second = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject,
      mode: 'automatic',
    });
    expect(second).toEqual([{ action: 'restrict', result: 'duplicate' }]);

    // One row, one effect: `previousStatePostStatus` still records the status the
    // FIRST delivery replaced, so a redelivery cannot rewrite it to 'restricted'
    // and make a later restore a no-op.
    const rows = await enforcementRows(decision.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].applied).toBe(true);
    expect(rows[0].previousStatePostStatus).toBe('published');
  });

  it('lets a correction restore the post to the status it had, and only once', async () => {
    // A DRAFT, so "restore" cannot pass by accidentally hardcoding 'published'.
    const postId = await createPost(uuidv7(), { status: 'draft' });
    const subject = { type: 'post', id: postId };

    const removal = uniqueDecision({ outcome: 'violation', revision: 1 });
    await applyDecisionEnforcement({
      decision: removal,
      caseId: removal.caseId,
      subject,
      mode: 'automatic',
    });
    expect((await readPost(postId))?.status).toBe('restricted');

    /**
     * §9.9: a decision is never edited, only superseded. Revision 2 is a DIFFERENT
     * action under the same key, which is exactly why `revision` is part of it — a
     * key of `decisionId + action` alone would refuse this restore as a duplicate of
     * the removal and leave the post down forever.
     */
    const correction = {
      ...decisionFixture({
        outcome: 'no_violation',
        revision: 2,
        status: 'corrected',
        supersedesDecisionId: removal.id,
      }),
      id: removal.id,
    };

    const restored = await applyDecisionEnforcement({
      decision: correction,
      caseId: correction.caseId,
      subject,
      mode: 'automatic',
    });
    expect(restored).toEqual([{ action: 'restore', result: 'applied' }]);
    // Restored to the status it HAD, read off the row that restricted it.
    expect((await readPost(postId))?.status).toBe('draft');

    const redelivered = await applyDecisionEnforcement({
      decision: correction,
      caseId: correction.caseId,
      subject,
      mode: 'automatic',
    });
    expect(redelivered).toEqual([{ action: 'restore', result: 'duplicate' }]);

    // Two actions total: one restriction, one restore. Not three.
    const rows = await enforcementRows(removal.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.action).sort()).toEqual(['restore', 'restrict']);
  });

  it('releases the claim when the effect fails, so a retry can still apply it', async () => {
    const postId = await createPost(uuidv7());
    const decision = uniqueDecision({ outcome: 'violation' });
    const subject = { type: 'post', id: postId };

    // Fail the UPDATE that carries the effect, leaving the claim already written.
    const update = vi
      .spyOn(db, 'update')
      .mockImplementationOnce(() => {
        throw new Error('write concern not met');
      });

    await expect(
      applyDecisionEnforcement({
        decision,
        caseId: decision.caseId,
        subject,
        mode: 'automatic',
      }),
    ).rejects.toThrow('write concern not met');
    update.mockRestore();

    /**
     * Nothing is left claimed. Keeping the row would dedupe the action away forever
     * and the decision would silently never be carried out — the worst outcome
     * available, because it looks exactly like success.
     */
    expect(await enforcementRows(decision.id)).toHaveLength(0);
    expect((await readPost(postId))?.status).toBe('published');

    const retry = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject,
      mode: 'automatic',
    });
    expect(retry).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect((await readPost(postId))?.status).toBe('restricted');
  });

  it('records the plan and removes nothing in observe mode', async () => {
    const postId = await createPost(uuidv7());
    const decision = uniqueDecision({ outcome: 'violation' });

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: postId },
      mode: 'observe',
    });

    // §15.6's definition of done: state is updated, content is not deleted.
    expect(outcomes).toEqual([{ action: 'restrict', result: 'recorded' }]);
    expect((await readPost(postId))?.status).toBe('published');

    // The plan is auditable rather than merely absent: the row says what would have
    // happened and why it did not.
    const rows = await enforcementRows(decision.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'restrict',
      mode: 'observe',
      applied: false,
      skippedReason: 'observe mode: recorded, not applied',
    });
  });

  it('never treats an observe-mode record as something to reverse', async () => {
    /**
     * `observe` writes a `restrict` row with `applied: false`. If the restore
     * lookup dropped that clause it would find this row, read its empty
     * `previousStatePostStatus`, and publish a post nothing ever restricted.
     */
    const postId = await createPost(uuidv7(), { status: 'restricted' });
    const subject = { type: 'post', id: postId };

    const observed = uniqueDecision({ outcome: 'violation', revision: 1 });
    await applyDecisionEnforcement({
      decision: observed,
      caseId: observed.caseId,
      subject,
      mode: 'observe',
    });

    const correction = uniqueDecision({ outcome: 'no_violation', revision: 1 });
    await applyDecisionEnforcement({
      decision: correction,
      caseId: correction.caseId,
      subject,
      mode: 'automatic',
    });

    // Nothing applied the restriction, so there is no recorded status to return
    // to and the documented default stands.
    expect((await readPost(postId))?.status).toBe('published');
  });

  it('records a recommendation it will not execute instead of dropping it', async () => {
    /**
     * §7.6 lets an application refuse or adapt a recommendation provided it records
     * what it did. Suspending an account is Oxy's to carry out, not Mention's, so it
     * becomes a note for a human — and it must still reach the record, or a
     * recommendation Mention declined looks like one it never received.
     */
    const postId = await createPost(uuidv7());
    const decision = {
      ...uniqueDecision({ outcome: 'violation' }),
      recommendedActions: [{ action: 'suspend_user' as const }],
    };

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'post', id: postId },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'manual_review', result: 'recorded' }]);
    expect((await readPost(postId))?.status).toBe('published');
    expect((await enforcementRows(decision.id))[0]).toMatchObject({
      action: 'manual_review',
      recommendedAction: 'suspend_user',
      applied: false,
    });
  });

  it('will not remove content for a reported account', async () => {
    const decision = uniqueDecision({ outcome: 'violation' });

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'user', id: 'oxy-user-subject' },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'recorded' }]);
    expect((await enforcementRows(decision.id))[0].skippedReason).toContain('reported user');
  });
});

describe('enforcement — the constraint the idempotency rests on', () => {
  it('declares Appendix D as a unique constraint, in the live database', async () => {
    /**
     * Read from `pg_constraint` rather than from the drizzle table object: the
     * mechanism under test is what the DATABASE enforces, and a schema file that
     * declares a constraint the migration never created would pass an assertion
     * made against the schema object while production removed a post twice.
     *
     * Drop `decision_revision` from this key and the correction test above fails
     * by name; drop the constraint entirely and the redelivery tests do.
     */
    const rows = await db.execute<{ constraint_name: string; columns: string }>(sql`
      select
        con.conname as constraint_name,
        string_agg(att.attname, ',' order by key.ordinality) as columns
      from pg_constraint con
      join lateral unnest(con.conkey) with ordinality as key(attnum, ordinality) on true
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = key.attnum
      where con.conrelid = 'moderation_enforcements'::regclass
        and con.contype = 'u'
      group by con.conname
    `);

    expect([...rows]).toEqual([
      {
        constraint_name: 'moderation_enforcements_idempotency_key',
        columns: 'decision_id,decision_revision,action',
      },
    ]);
  });

  it('refuses a second row for the same decision, revision and action', async () => {
    /**
     * The constraint asserted directly, so the tests above cannot be the only
     * thing standing between a weakened key and a post removed twice.
     */
    const decisionId = `dec_${randomUUID()}`;
    usedDecisionIds.push(decisionId);
    const row = {
      decisionId,
      decisionRevision: 1,
      action: 'restrict' as const,
      caseId: 'case_dup',
      subjectType: 'post',
      subjectId: uuidv7(),
      outcome: 'violation',
      reason: 'duplicate probe',
      mode: 'automatic' as const,
    };

    await db.insert(moderationEnforcements).values(row);
    await expect(db.insert(moderationEnforcements).values(row)).rejects.toThrow();

    // A different revision is a DIFFERENT action and must still be accepted, or a
    // correction could never restore what a removal took down.
    await db.insert(moderationEnforcements).values({ ...row, decisionRevision: 2 });
    const stored = await db
      .select({ revision: moderationEnforcements.decisionRevision })
      .from(moderationEnforcements)
      .where(
        and(
          eq(moderationEnforcements.decisionId, decisionId),
          eq(moderationEnforcements.action, 'restrict'),
        ),
      );
    expect(stored.map((entry) => entry.revision).sort()).toEqual([1, 2]);
  });
});

describe('enforcement plan — §14.7 mapping', () => {
  /**
   * A table, because the planner is pure. Each row is a claim about what Mention
   * does with a decision, and the one that matters most is the last group: an
   * outcome with no consensus never becomes an action.
   */
  const cases: ReadonlyArray<{
    name: string;
    decision: Parameters<typeof planEnforcement>[0];
    expected: readonly string[];
  }> = [
    {
      name: 'a violation recommending removal restricts',
      decision: decisionFixture({ outcome: 'violation' }),
      expected: ['restrict'],
    },
    {
      /**
       * The row that caught a real bug. The fixture's `no_violation` recommends
       * `no_action`, which maps to `none` — and a correction that plans `none` leaves
       * the post its superseded revision removed down forever. `no_action` means "take
       * no NEW action", so the restore is added regardless of the recommendation.
       */
      name: 'no_violation restores even when it recommends no_action',
      decision: decisionFixture({ outcome: 'no_violation' }),
      expected: ['restore'],
    },
    {
      name: 'insufficient_context asks a human, never an effect',
      decision: {
        ...decisionFixture({ outcome: 'violation' }),
        outcome: 'insufficient_context' as const,
        findings: [],
        recommendedActions: [],
      },
      expected: ['manual_review'],
    },
    {
      name: 'inconclusive is neither guilt nor innocence',
      decision: {
        ...decisionFixture({ outcome: 'violation' }),
        outcome: 'inconclusive' as const,
        findings: [],
        recommendedActions: [],
      },
      expected: ['manual_review'],
    },
    {
      name: 'a label recommendation applies a content warning',
      decision: {
        ...decisionFixture({ outcome: 'violation' }),
        recommendedActions: [{ action: 'allow_with_label' as const }],
      },
      expected: ['label_sensitive'],
    },
    {
      name: 'removal absorbs a label recommended alongside it',
      decision: {
        ...decisionFixture({ outcome: 'violation' }),
        recommendedActions: [{ action: 'remove' as const }, { action: 'label' as const }],
      },
      expected: ['restrict'],
    },
    {
      name: 'a violation with no recommendation falls back to severity',
      decision: {
        ...decisionFixture({ outcome: 'violation' }),
        recommendedActions: [],
      },
      // The fixture's finding is `medium`, so a content warning rather than removal.
      expected: ['label_sensitive'],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(planEnforcement(testCase.decision).map((planned) => planned.action)).toEqual(
        testCase.expected,
      );
    });
  }

  it('never returns an empty plan', () => {
    /**
     * A vacuity floor. "We decided to do nothing, and why" is evidence; an absent row
     * is a question nobody can answer months later.
     */
    for (const testCase of cases) {
      expect(planEnforcement(testCase.decision).length).toBeGreaterThan(0);
    }
  });
});
