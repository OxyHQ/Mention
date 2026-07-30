import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionFixture } from '@oxyhq/crowdsource-testing';

/**
 * A redelivered decision enforces exactly once (Appendix D).
 *
 * §10.9 retries a delivery six times over 24 hours, and a retry also happens when
 * the receiver's 2xx was simply lost. So the same decision WILL arrive twice at a
 * healthy deployment, and the only thing standing between that and a post being
 * removed twice — or, worse, a correction restoring it twice and undoing a later
 * legitimate removal — is the unique key on `decisionId + revision + action`.
 *
 * ## Why the fake reads its key from the real schema
 *
 * The mechanism under test lives in a Mongo index, and a test that hard-coded the
 * same key into its own fake would prove only that the test agrees with itself:
 * delete `decisionRevision` from the model and both the model and the fake would
 * change together, silently. So the fake derives its dedupe key FROM
 * `ModerationEnforcement.schema.indexes()`. Weaken the real index and these tests
 * fail, and the last test in this file names which index it was.
 */

import ModerationEnforcement, {
  type IModerationEnforcement,
} from '../../../models/ModerationEnforcement';
import Post from '../../../models/Post';
import { applyDecisionEnforcement } from '../../../services/moderation/ModerationEnforcementService';
import { planEnforcement } from '../../../services/moderation/enforcementPlan';

type Doc = Record<string, unknown>;

/**
 * The declared unique index on `ModerationEnforcement`, as fields.
 *
 * Throws rather than falling back to a default: a fake that quietly dedupes on a
 * key the database does not enforce is a test that passes while production removes
 * a post twice.
 */
function uniqueIndexFields(): string[] {
  const indexes = ModerationEnforcement.schema.indexes();
  const unique = indexes.filter(([, options]) => options?.unique === true);
  if (unique.length !== 1) {
    throw new Error(
      `Expected exactly one unique index on ModerationEnforcement, found ${unique.length}. ` +
        'Enforcement idempotency depends on it; this test cannot stand in for an index that is not declared.',
    );
  }
  return Object.keys(unique[0][0]);
}

/** An in-memory collection that enforces the schema's own unique index. */
class FakeEnforcementCollection {
  readonly rows: Doc[] = [];
  private readonly keyFields = uniqueIndexFields();
  private nextId = 1;

  private keyOf(doc: Doc): string {
    return this.keyFields.map((field) => String(doc[field])).join('|');
  }

  create(doc: Doc): Doc {
    const key = this.keyOf(doc);
    if (this.rows.some((row) => this.keyOf(row) === key)) {
      // The shape Mongo throws for a unique-index violation.
      const error = new Error(`E11000 duplicate key error: ${key}`);
      Object.assign(error, { code: 11000 });
      throw error;
    }
    const row: Doc = { ...doc, _id: `enf_${this.nextId++}`, createdAt: new Date() };
    this.rows.push(row);
    return row;
  }

  findOne(filter: Doc): Doc | null {
    const matched = this.rows.filter((row) =>
      Object.entries(filter).every(([field, value]) => row[field] === value),
    );
    // Newest first, matching the `.sort({ createdAt: -1 })` the service asks for.
    return matched.length > 0 ? matched[matched.length - 1] : null;
  }

  updateOne(filter: Doc, update: Doc): void {
    const row = this.rows.find((candidate) => candidate._id === filter._id);
    if (!row) return;
    Object.assign(row, (update.$set as Doc | undefined) ?? {});
  }

  deleteOne(filter: Doc): void {
    const index = this.rows.findIndex((row) => row._id === filter._id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

const POST_ID = '507f1f77bcf86cd799439022';
const SUBJECT = { type: 'post', id: POST_ID };

let enforcements: FakeEnforcementCollection;
/** The post, as the enforcement effect mutates it. */
let post: Doc;

function wireModels(): void {
  vi.spyOn(ModerationEnforcement, 'create').mockImplementation((async (doc: Doc) =>
    enforcements.create(doc)) as never);

  vi.spyOn(ModerationEnforcement, 'findOne').mockImplementation(((filter: Doc) => {
    const query = {
      sort: () => query,
      lean: async () => enforcements.findOne(filter),
    };
    return query as never;
  }) as never);

  vi.spyOn(ModerationEnforcement, 'updateOne').mockImplementation((async (
    filter: Doc,
    update: Doc,
  ) => {
    enforcements.updateOne(filter, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }) as never);

  vi.spyOn(ModerationEnforcement, 'deleteOne').mockImplementation((async (filter: Doc) => {
    enforcements.deleteOne(filter);
    return { deletedCount: 1 };
  }) as never);

  vi.spyOn(Post, 'findById').mockImplementation((() => {
    const query = {
      select: () => query,
      lean: async () => ({ ...post }),
    };
    return query as never;
  }) as never);

  vi.spyOn(Post, 'updateOne').mockImplementation((async (_filter: Doc, update: Doc) => {
    const set = (update.$set as Record<string, unknown> | undefined) ?? {};
    for (const [path, value] of Object.entries(set)) {
      if (path === 'metadata.isSensitive') {
        post.metadata = { ...(post.metadata as Doc | undefined), isSensitive: value };
      } else {
        post[path] = value;
      }
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }) as never);
}

describe('enforcement — idempotent on decisionId + revision + action', () => {
  beforeEach(() => {
    enforcements = new FakeEnforcementCollection();
    post = { _id: POST_ID, status: 'published', metadata: { isSensitive: false } };
    wireModels();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes a post once, however many times the decision is delivered', async () => {
    const decision = decisionFixture({ outcome: 'violation' });

    const first = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: SUBJECT,
      mode: 'automatic',
    });
    expect(first).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect(post.status).toBe('restricted');

    // The redelivery §10.9 guarantees will happen.
    const second = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: SUBJECT,
      mode: 'automatic',
    });
    expect(second).toEqual([{ action: 'restrict', result: 'duplicate' }]);

    // One row, one effect. `applied` is still true from the first delivery, and the
    // post was not touched again.
    expect(enforcements.rows).toHaveLength(1);
    expect(enforcements.rows[0].applied).toBe(true);
    expect(Post.updateOne).toHaveBeenCalledTimes(1);
  });

  it('lets a correction restore the post, and only once', async () => {
    const removal = decisionFixture({ outcome: 'violation', revision: 1 });
    await applyDecisionEnforcement({
      decision: removal,
      caseId: removal.caseId,
      subject: SUBJECT,
      mode: 'automatic',
    });
    expect(post.status).toBe('restricted');

    /**
     * §9.9: a decision is never edited, only superseded. Revision 2 is a DIFFERENT
     * action under the same key, which is exactly why `revision` is part of it — a
     * key of `decisionId + action` alone would refuse this restore as a duplicate of
     * the removal and leave the post down forever.
     */
    const correction = decisionFixture({
      outcome: 'no_violation',
      revision: 2,
      status: 'corrected',
      supersedesDecisionId: removal.id,
    });

    const restored = await applyDecisionEnforcement({
      decision: correction,
      caseId: correction.caseId,
      subject: SUBJECT,
      mode: 'automatic',
    });
    expect(restored).toEqual([{ action: 'restore', result: 'applied' }]);
    // Restored to the status it HAD, read off the row that restricted it.
    expect(post.status).toBe('published');

    const redelivered = await applyDecisionEnforcement({
      decision: correction,
      caseId: correction.caseId,
      subject: SUBJECT,
      mode: 'automatic',
    });
    expect(redelivered).toEqual([{ action: 'restore', result: 'duplicate' }]);

    // Two actions total: one restriction, one restore. Not three.
    expect(enforcements.rows).toHaveLength(2);
    expect(enforcements.rows.map((row) => row.action)).toEqual(['restrict', 'restore']);
    expect(Post.updateOne).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when the effect fails, so a retry can still apply it', async () => {
    const decision = decisionFixture({ outcome: 'violation' });
    vi.mocked(Post.updateOne).mockRejectedValueOnce(new Error('write concern not met'));

    await expect(
      applyDecisionEnforcement({
        decision,
        caseId: decision.caseId,
        subject: SUBJECT,
        mode: 'automatic',
      }),
    ).rejects.toThrow('write concern not met');

    /**
     * Nothing is left claimed. Keeping the row would dedupe the action away forever
     * and the decision would silently never be carried out — the worst outcome
     * available, because it looks exactly like success.
     */
    expect(enforcements.rows).toHaveLength(0);

    const retry = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: SUBJECT,
      mode: 'automatic',
    });
    expect(retry).toEqual([{ action: 'restrict', result: 'applied' }]);
    expect(post.status).toBe('restricted');
  });

  it('records the plan and removes nothing in observe mode', async () => {
    const decision = decisionFixture({ outcome: 'violation' });

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: SUBJECT,
      mode: 'observe',
    });

    // §15.6's definition of done: state is updated, content is not deleted.
    expect(outcomes).toEqual([{ action: 'restrict', result: 'recorded' }]);
    expect(post.status).toBe('published');
    expect(Post.updateOne).not.toHaveBeenCalled();

    // The plan is auditable rather than merely absent: the row says what would have
    // happened and why it did not.
    expect(enforcements.rows).toHaveLength(1);
    expect(enforcements.rows[0]).toMatchObject({
      action: 'restrict',
      mode: 'observe',
      applied: false,
      skippedReason: 'observe mode: recorded, not applied',
    });
  });

  it('records a recommendation it will not execute instead of dropping it', async () => {
    /**
     * §7.6 lets an application refuse or adapt a recommendation provided it records
     * what it did. Suspending an account is Oxy's to carry out, not Mention's, so it
     * becomes a note for a human — and it must still reach the record, or a
     * recommendation Mention declined looks like one it never received.
     */
    const decision = {
      ...decisionFixture({ outcome: 'violation' }),
      recommendedActions: [{ action: 'suspend_user' as const }],
    };

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: SUBJECT,
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'manual_review', result: 'recorded' }]);
    expect(post.status).toBe('published');
    expect(enforcements.rows[0]).toMatchObject({
      action: 'manual_review',
      recommendedAction: 'suspend_user',
      applied: false,
    });
  });

  it('will not remove content for a reported account', async () => {
    const decision = decisionFixture({ outcome: 'violation' });

    const outcomes = await applyDecisionEnforcement({
      decision,
      caseId: decision.caseId,
      subject: { type: 'user', id: 'oxy-user-subject' },
      mode: 'automatic',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'recorded' }]);
    expect(Post.updateOne).not.toHaveBeenCalled();
    expect(enforcements.rows[0].skippedReason).toContain('reported user');
  });
});

describe('enforcement — the index the idempotency rests on', () => {
  it('declares Appendix D as a unique compound index', () => {
    /**
     * The assertion that makes the fake above trustworthy. Weaken this index —
     * remove `decisionRevision`, drop `unique` — and either this test fails by name
     * or `uniqueIndexFields()` throws and every test in this file fails with the
     * reason. Nothing else in the codebase would notice: the damage would appear in
     * production as a post removed twice, or a correction that could not restore.
     */
    const indexes = ModerationEnforcement.schema.indexes();
    const unique = indexes.filter(([, options]) => options?.unique === true);

    expect(unique).toHaveLength(1);
    expect(Object.keys(unique[0][0])).toEqual([
      'decisionId',
      'decisionRevision',
      'action',
    ]);
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
