/**
 * An accepted appeal puts the post back the way it was — not the way some OTHER
 * restriction left it.
 *
 * `restore` reads the status to return to off the enforcement row that
 * restricted the post. Which row that is, is a question about ORDER, and the two
 * obvious answers are both wrong here:
 *
 *  - **`created_at`** defaults to `now()`, i.e. `transaction_timestamp()`, so
 *    every row written inside ONE transaction carries it identically to the
 *    microsecond. A batched import of a post's enforcement history is exactly
 *    that transaction, and `order by created_at desc limit 1` over those rows is
 *    a TIE — decided by whichever row the scan reached first, which is not a
 *    decision anybody made.
 *  - **`id`** is `text` holding a 24-char ObjectId hex for every pre-cutover row
 *    and a uuid v7 for everything after; `'0' < '6'` under the database's
 *    collation, so `order by id desc` puts every post-cutover row LAST and picks
 *    the oldest enforcement on record every single time.
 *
 * So the fixture below stages both at once — two applied restrictions written in
 * one transaction, the stale one carrying the ObjectId-shaped id and the one
 * actually in force carrying the uuid — and asserts the outcome a user would
 * notice: whether their reinstated post is visible.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decisionFixture } from '@oxyhq/crowdsource-testing';

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { moderationEnforcements } from '../../../db/schema/moderation';
import { posts } from '../../../db/schema/posts';
import { uuidv7 } from '../../../db/schema/columns';
import { applyDecisionEnforcement } from '../../../services/moderation/ModerationEnforcementService';

let db: Database;
const createdPostIds: string[] = [];
const usedDecisionIds: string[] = [];

/**
 * Vitest runs test FILES in parallel against ONE database, so every id this file
 * writes is namespaced: `decision_id` is half of a GLOBAL unique key, and a
 * literal shared with another file would deduplicate that file's enforcement
 * rather than this one's.
 */
const NAMESPACE = `restore-order-${randomUUID().slice(0, 8)}`;

/** A 24-char ObjectId hex — the shape of every id written before the cutover. */
function objectIdHex(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

function decisionId(label: string): string {
  const id = `dec_${NAMESPACE}_${label}`;
  usedDecisionIds.push(id);
  return id;
}

async function createRestrictedPost(): Promise<string> {
  const id = uuidv7();
  await db.insert(posts).values({
    id,
    oxyUserId: `oxy-${NAMESPACE}-author`,
    status: 'restricted',
  });
  createdPostIds.push(id);
  return id;
}

async function readStatus(id: string): Promise<string | undefined> {
  const [row] = await db.select({ status: posts.status }).from(posts).where(eq(posts.id, id)).limit(1);
  return row?.status;
}

/**
 * Two applied restrictions of the same post, written in ONE transaction so they
 * share `created_at` exactly, and given the two id shapes the column really
 * holds. `appliedAt` is the only thing that distinguishes them, which is the
 * whole point: it is the only column that records when the effect happened.
 */
async function stageTwoRestrictions(
  postId: string,
  stale: { appliedAt: Date; restoreTo: string },
  inForce: { appliedAt: Date; restoreTo: string },
): Promise<void> {
  const common = {
    decisionRevision: 1,
    action: 'restrict' as const,
    caseId: `case_${NAMESPACE}`,
    subjectType: 'post',
    subjectId: postId,
    outcome: 'violation',
    reason: 'staged restriction',
    mode: 'automatic' as const,
    applied: true,
  };
  await db.transaction(async (tx) => {
    // The STALE row first: under a `created_at` tie the scan reaches it first,
    // and its ObjectId-shaped id also outranks a uuid under `order by id desc`.
    await tx.insert(moderationEnforcements).values({
      ...common,
      id: objectIdHex(),
      decisionId: decisionId('stale'),
      appliedAt: stale.appliedAt,
      previousStatePostStatus: stale.restoreTo,
    });
    await tx.insert(moderationEnforcements).values({
      ...common,
      id: uuidv7(),
      decisionId: decisionId('in-force'),
      appliedAt: inForce.appliedAt,
      previousStatePostStatus: inForce.restoreTo,
    });
  });
}

/** The `created_at` of every staged restriction, so the fixture can prove it tied. */
async function stagedCreatedAt(postId: string): Promise<number[]> {
  const rows = await db
    .select({ createdAt: moderationEnforcements.createdAt })
    .from(moderationEnforcements)
    .where(eq(moderationEnforcements.subjectId, postId));
  return rows.map((row) => row.createdAt.getTime());
}

/** Apply a correction — the decision an accepted appeal produces. */
async function acceptTheAppeal(postId: string) {
  const correction = {
    ...decisionFixture({ outcome: 'no_violation', revision: 1 }),
    id: decisionId('appeal'),
  };
  return applyDecisionEnforcement({
    decision: correction,
    caseId: correction.caseId,
    subject: { type: 'post', id: postId },
    mode: 'automatic',
  });
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (usedDecisionIds.length > 0) {
    const id = usedDecisionIds.pop();
    if (id) await db.delete(moderationEnforcements).where(eq(moderationEnforcements.decisionId, id));
  }
  while (createdPostIds.length > 0) {
    const id = createdPostIds.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('restore — reverses the restriction that is actually in force', () => {
  it('the staged restrictions really do share a created_at', async () => {
    /**
     * The vacuity floor. Every assertion below is about what happens when
     * `created_at` cannot separate two rows; if the column ever stopped
     * collapsing inside a transaction, those tests would keep passing while
     * testing nothing, and this one says so instead.
     */
    const postId = await createRestrictedPost();
    await stageTwoRestrictions(
      postId,
      { appliedAt: new Date('2025-03-01T00:00:00.000Z'), restoreTo: 'draft' },
      { appliedAt: new Date('2026-05-01T00:00:00.000Z'), restoreTo: 'published' },
    );

    const stamps = await stagedCreatedAt(postId);
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toBe(stamps[1]);
  });

  it('republishes the post rather than reinstating it as an invisible draft', async () => {
    /**
     * The failure a user would report. The post was a DRAFT when an old, since-
     * lifted restriction hit it, and `published` when the restriction the appeal
     * is about took it down. Reverse the wrong row and the appeal "succeeds"
     * while the post comes back as a draft — visible to nobody, absent from
     * every feed and from the author's own profile, with no error anywhere and
     * an audit trail that says `applied: true`.
     */
    const postId = await createRestrictedPost();
    await stageTwoRestrictions(
      postId,
      { appliedAt: new Date('2025-03-01T00:00:00.000Z'), restoreTo: 'draft' },
      { appliedAt: new Date('2026-05-01T00:00:00.000Z'), restoreTo: 'published' },
    );

    await expect(acceptTheAppeal(postId)).resolves.toEqual([
      { action: 'restore', result: 'applied' },
    ]);
    expect(await readStatus(postId)).toBe('published');
  });

  it('does not publish a post whose live restriction took it down as a draft', async () => {
    /**
     * The same guarantee in the direction the previous case cannot see. Swap
     * which restriction is in force and the correct answer swaps with it — so
     * neither test can be satisfied by pinning the result to one status, which
     * is what `asPostStatus`'s `published` default would silently do.
     */
    const postId = await createRestrictedPost();
    await stageTwoRestrictions(
      postId,
      { appliedAt: new Date('2025-03-01T00:00:00.000Z'), restoreTo: 'published' },
      { appliedAt: new Date('2026-05-01T00:00:00.000Z'), restoreTo: 'draft' },
    );

    await expect(acceptTheAppeal(postId)).resolves.toEqual([
      { action: 'restore', result: 'applied' },
    ]);
    expect(await readStatus(postId)).toBe('draft');
  });
});
