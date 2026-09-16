/**
 * `PollVoteService` against REAL Postgres rows.
 *
 * The previous version stubbed the `Poll` model and asserted the SHAPE of the
 * `findOneAndUpdate` filter — it proved a dedup guard was written, never that a
 * duplicate vote failed to land. Mongo supplied the atomicity; Postgres has to
 * be shown supplying it, so the assertions here are on `poll_votes` rows.
 *
 * What is load-bearing:
 *
 *  - **A duplicate never double-counts.** Single-choice means "no vote on ANY
 *    option of this poll", multiple-choice means "no vote on THIS option". Only
 *    the second has a unique constraint behind it (`poll_votes_option_id_user_id_key`);
 *    the first is held by the `select … for update` on the poll row, which the
 *    concurrency test below exercises directly.
 *  - **No voter identity ever comes back, from either side of the anonymity
 *    line.** `options[].votes` used to publish the array of voter ids Mongo
 *    held for a visible poll (and, for an anonymous one, its own `.length`
 *    under the SAME field — the ambiguity that crashed the poll card). Both are
 *    gone: `voteCount` is unconditionally a number, and `viewerSelectedOptionIds`
 *    carries only the CALLER's own selection.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '@oxy.so/db';
import { pollOptions, pollVotes, polls } from '../../db/schema/polls';
import { loadPollHeader, loadPollSummary, pollVoteService } from '../../services/PollVoteService';

let db: Database;
const createdPollIds: string[] = [];

const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

interface SeedPollOptions {
  isMultipleChoice?: boolean;
  isAnonymous?: boolean;
  endsAt?: Date;
  options?: string[];
}

async function seedPoll(overrides: SeedPollOptions = {}) {
  const [poll] = await db
    .insert(polls)
    .values({
      question: 'Favourite colour?',
      createdBy: `oxy-poll-author-${randomUUID()}`,
      endsAt: overrides.endsAt ?? FUTURE,
      isMultipleChoice: overrides.isMultipleChoice ?? false,
      isAnonymous: overrides.isAnonymous ?? false,
    })
    .returning();
  createdPollIds.push(poll.id);

  const texts = overrides.options ?? ['Red', 'Blue'];
  const options = await db
    .insert(pollOptions)
    .values(texts.map((text, position) => ({ pollId: poll.id, position, text })))
    .returning();
  return { poll, options };
}

async function voteRows(pollId: string) {
  return db.select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdPollIds.length > 0) {
    // Options and votes cascade from the poll.
    await db.delete(polls).where(inArray(polls.id, createdPollIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('recordVoteByOptionId — the local HTTP vote route', () => {
  it('records the vote and returns counts plus the voter\'s own selection', async () => {
    const { poll, options } = await seedPoll();
    const voter = `voter-${randomUUID()}`;

    const result = await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, voter);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.options.map((option) => option.text)).toEqual(['Red', 'Blue']);
    expect(result.poll.options[0].voteCount).toBe(0);
    expect(result.poll.options[1].voteCount).toBe(1);
    expect(result.poll.viewerSelectedOptionIds).toEqual([options[1].id]);
    // The rest of `PollHeader` rides along unchanged.
    expect(result.poll.id).toBe(poll.id);
    expect(result.poll.question).toBe('Favourite colour?');

    const rows = await voteRows(poll.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ optionId: options[1].id, pollId: poll.id, userId: voter });
  });

  it('reports another voter\'s ballot only as a count, never in viewerSelectedOptionIds', async () => {
    const { poll, options } = await seedPoll();
    const first = `voter-a-${randomUUID()}`;
    const second = `voter-b-${randomUUID()}`;

    await pollVoteService.recordVoteByOptionId(poll.id, options[0].id, first);
    const result = await pollVoteService.recordVoteByOptionId(poll.id, options[0].id, second);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.options[0].voteCount).toBe(2);
    // `second` voted for options[0] too, so it is THEIR own selection — not a
    // trace of `first`'s ballot, which never appears anywhere in the response.
    expect(result.poll.viewerSelectedOptionIds).toEqual([options[0].id]);
  });

  it('refuses a second vote on a SINGLE-choice poll and writes no row', async () => {
    const { poll, options } = await seedPoll();
    const voter = `voter-${randomUUID()}`;

    await pollVoteService.recordVoteByOptionId(poll.id, options[0].id, voter);
    const second = await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, voter);

    expect(second).toEqual({ ok: false, reason: 'already_voted' });
    expect(await voteRows(poll.id)).toHaveLength(1);
  });

  it('lets a MULTIPLE-choice voter pick two options but not the same one twice', async () => {
    const { poll, options } = await seedPoll({ isMultipleChoice: true });
    const voter = `voter-${randomUUID()}`;

    const firstVote = await pollVoteService.recordVoteByOptionId(poll.id, options[0].id, voter);
    expect(firstVote.ok).toBe(true);
    const secondVote = await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, voter);
    expect(secondVote.ok).toBe(true);
    if (!secondVote.ok) return;
    expect(secondVote.poll.viewerSelectedOptionIds.sort()).toEqual([options[0].id, options[1].id].sort());

    expect(await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, voter)).toEqual({
      ok: false,
      reason: 'already_voted',
    });
    expect(await voteRows(poll.id)).toHaveLength(2);
  });

  it('two CONCURRENT votes by one voter produce exactly one row', async () => {
    /**
     * The reason the vote runs inside a transaction that takes
     * `select … for update` on the poll: single-choice dedup has no constraint
     * behind it, so a plain read-then-insert would let both of these observe an
     * empty `poll_votes` and both insert. See the module docblock in
     * `PollVoteService.ts` and the schema gap noted in the migration report.
     */
    const { poll, options } = await seedPoll();
    const voter = `voter-${randomUUID()}`;

    const results = await Promise.all([
      pollVoteService.recordVoteByOptionId(poll.id, options[0].id, voter),
      pollVoteService.recordVoteByOptionId(poll.id, options[1].id, voter),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'already_voted' },
    ]);
    expect(await voteRows(poll.id)).toHaveLength(1);
  });

  it('rejects a vote after the poll has ended, writing nothing', async () => {
    const { poll, options } = await seedPoll({ endsAt: PAST });
    const result = await pollVoteService.recordVoteByOptionId(poll.id, options[0].id, 'voter-1');

    expect(result).toEqual({ ok: false, reason: 'poll_ended' });
    expect(await voteRows(poll.id)).toEqual([]);
  });

  it('reports option_not_found for an option id that belongs to another poll', async () => {
    const mine = await seedPoll();
    const theirs = await seedPoll();

    const result = await pollVoteService.recordVoteByOptionId(
      mine.poll.id,
      theirs.options[0].id,
      'voter-1',
    );
    expect(result).toEqual({ ok: false, reason: 'option_not_found' });
    expect(await voteRows(mine.poll.id)).toEqual([]);
    expect(await voteRows(theirs.poll.id)).toEqual([]);
  });

  it('reports poll_not_found for an id that names nothing, whatever its shape', async () => {
    // No `isValidObjectId` guard survives here: a `text` id that matches no row
    // already answers "no such poll", and a uuid v7 is a perfectly real id.
    for (const id of [uuidv7(), 'not-an-id-at-all']) {
      expect(await pollVoteService.recordVoteByOptionId(id, 'whatever', 'voter-1')).toEqual({
        ok: false,
        reason: 'poll_not_found',
      });
    }
  });
});

describe('recordVoteByOptionText — the inbound ActivityPub path', () => {
  it('resolves the option by its name, the way a Mastodon vote references it', async () => {
    const { poll, options } = await seedPoll();
    const voter = `voter-${randomUUID()}`;

    const result = await pollVoteService.recordVoteByOptionText(poll.id, 'Blue', voter);

    expect(result.ok).toBe(true);
    const rows = await voteRows(poll.id);
    expect(rows.map((row) => row.optionId)).toEqual([options[1].id]);
  });

  it('reports option_not_found for a name no option carries', async () => {
    const { poll } = await seedPoll();
    expect(await pollVoteService.recordVoteByOptionText(poll.id, 'Green', 'voter-1')).toEqual({
      ok: false,
      reason: 'option_not_found',
    });
    expect(await voteRows(poll.id)).toEqual([]);
  });
});

describe('loadPollHeader', () => {
  it('reads the poll\'s own columns, with no options and no votes', async () => {
    const { poll } = await seedPoll({ isAnonymous: true });
    const header = await loadPollHeader(db, poll.id);
    expect(header).toMatchObject({
      id: poll.id,
      question: 'Favourite colour?',
      isAnonymous: true,
    });
    expect(header && Object.keys(header)).not.toContain('options');
  });

  it('returns null for a poll that does not exist', async () => {
    expect(await loadPollHeader(db, uuidv7())).toBeNull();
  });
});

describe('loadPollSummary', () => {
  it('keeps options in author order and counts every voter without naming them', async () => {
    const { poll, options } = await seedPoll({ options: ['A', 'B', 'C'] });
    const first = `voter-a-${randomUUID()}`;
    const second = `voter-b-${randomUUID()}`;
    const third = `voter-c-${randomUUID()}`;

    await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, first);
    await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, second);
    await pollVoteService.recordVoteByOptionId(poll.id, options[2].id, third);

    const summary = await loadPollSummary(db, poll.id, second);
    expect(summary?.options.map((option) => option.text)).toEqual(['A', 'B', 'C']);
    expect(summary?.options.map((option) => option.voteCount)).toEqual([0, 2, 1]);
    // `second` is the viewer here: their own ballot, and no one else's.
    expect(summary?.viewerSelectedOptionIds).toEqual([options[1].id]);
  });

  it('reports no selection for a viewer who has not voted', async () => {
    const { poll } = await seedPoll();
    const summary = await loadPollSummary(db, poll.id, `non-voter-${randomUUID()}`);
    expect(summary?.viewerSelectedOptionIds).toEqual([]);
  });

  it('returns null for a poll that does not exist', async () => {
    expect(await loadPollSummary(db, uuidv7(), 'voter-1')).toBeNull();
  });

  it('stays correct at a vote count no single-row read could produce by accident', async () => {
    // Not a benchmark — the issue is explicit that timing claims need real
    // instrumentation this suite does not have. What this DOES prove: counts
    // and viewer selection are computed by aggregation, not by an off-by-one
    // in a hand-rolled reduce that happens to pass at N=3.
    const { poll, options } = await seedPoll({ options: ['A', 'B'] });
    const voters = Array.from({ length: 97 }, () => `voter-${randomUUID()}`);
    for (const [index, voter] of voters.entries()) {
      await pollVoteService.recordVoteByOptionId(poll.id, options[index % 2 === 0 ? 0 : 1].id, voter);
    }
    const expectedA = voters.filter((_, index) => index % 2 === 0).length;
    const expectedB = voters.length - expectedA;

    const viewer = voters[41];
    const summary = await loadPollSummary(db, poll.id, viewer);
    expect(summary?.options.map((option) => option.voteCount)).toEqual([expectedA, expectedB]);
    expect(summary?.viewerSelectedOptionIds).toEqual([options[41 % 2 === 0 ? 0 : 1].id]);
  });
});
