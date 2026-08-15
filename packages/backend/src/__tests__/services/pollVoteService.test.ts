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
 *  - **The wire array survives.** Mongo published `options[].votes` as an array
 *    of voter ids in vote order; the rows have to come back the same way.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '@oxyhq/db';
import { pollOptions, pollVotes, polls } from '../../db/schema/polls';
import { loadPollRecord, pollVoteService } from '../../services/PollVoteService';

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
  it('records the vote and returns the poll with the voter on that option', async () => {
    const { poll, options } = await seedPoll();
    const voter = `voter-${randomUUID()}`;

    const result = await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, voter);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.poll.options.map((option) => option.text)).toEqual(['Red', 'Blue']);
    expect(result.poll.options[0].votes).toEqual([]);
    expect(result.poll.options[1].votes).toEqual([voter]);

    const rows = await voteRows(poll.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ optionId: options[1].id, pollId: poll.id, userId: voter });
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

    expect((await pollVoteService.recordVoteByOptionId(poll.id, options[0].id, voter)).ok).toBe(true);
    expect((await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, voter)).ok).toBe(true);
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

describe('loadPollRecord', () => {
  it('keeps options in author order and voters in vote order', async () => {
    const { poll, options } = await seedPoll({ options: ['A', 'B', 'C'] });
    const first = `voter-a-${randomUUID()}`;
    const second = `voter-b-${randomUUID()}`;
    const third = `voter-c-${randomUUID()}`;

    await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, first);
    await pollVoteService.recordVoteByOptionId(poll.id, options[1].id, second);
    await pollVoteService.recordVoteByOptionId(poll.id, options[2].id, third);

    const record = await loadPollRecord(db, poll.id);
    expect(record?.options.map((option) => option.text)).toEqual(['A', 'B', 'C']);
    expect(record?.options[0].votes).toEqual([]);
    expect(record?.options[1].votes).toEqual([first, second]);
    expect(record?.options[2].votes).toEqual([third]);
  });

  it('returns null for a poll that does not exist', async () => {
    expect(await loadPollRecord(db, uuidv7())).toBeNull();
  });
});
