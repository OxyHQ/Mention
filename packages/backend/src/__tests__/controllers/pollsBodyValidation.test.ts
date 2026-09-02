/**
 * What `POST /polls` and `POST /polls/:id/vote` accept, in both directions.
 *
 * The hand-rolled checks these replace tested `question` for TRUTHINESS and
 * nothing else, so any JSON value became a row in `polls.question`; bounded
 * `options` from BELOW (`length < 2`) and not from above, so one request could
 * insert an unbounded number of `poll_options` rows; and read the booleans as
 * `x || false`, which handed a truthy non-boolean to a `boolean NOT NULL`
 * column and let Postgres decide (`'yes'` casts, `'banana'` is a 500).
 *
 * The vote route reached its query through `String(optionId)` — the coercion
 * `utils/queryParams.ts` documents as the hazard it exists to avoid, since
 * `String(['<an option id>'])` IS that id.
 *
 * Both halves matter: the valid bodies below are the ones the route answered 201
 * and 200 to before, and they still do.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import pollsController from '../../controllers/polls.controller';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { pollOptions, pollVotes, polls } from '../../db/schema/polls';

let db: Database;
const createdPollIds: string[] = [];

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeRes(captured: CapturedResponse) {
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return res;
}

/** Run a detached handler — the registration `routes/polls.ts` actually uses. */
async function call(
  handler: (req: never, res: never, next: never) => Promise<unknown>,
  req: Record<string, unknown>,
): Promise<{ captured: CapturedResponse; next: ReturnType<typeof vi.fn> }> {
  const captured: CapturedResponse = { status: 200, body: undefined };
  const next = vi.fn();
  await handler(req as never, makeRes(captured) as never, next as never);
  return { captured, next };
}

/** `POST /polls` with a body, as the composer's pre-post placeholder sends it. */
async function createPoll(body: Record<string, unknown>) {
  const { createPoll: handler } = pollsController;
  const authorId = `author-${randomUUID()}`;
  const result = await call(handler, { body, user: { id: authorId } });
  const created = (result.captured.body as { data?: { _id?: string } } | undefined)?.data;
  if (created?._id) createdPollIds.push(created._id);
  return { ...result, authorId };
}

/** Rows attributable only to this request, isolated from parallel DB suites. */
async function countPollsByAuthor(authorId: string): Promise<number> {
  const rows = await db.select({ id: polls.id }).from(polls).where(eq(polls.createdBy, authorId));
  return rows.length;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (createdPollIds.length > 0) {
    await db.delete(polls).where(inArray(polls.id, createdPollIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('POST /polls body validation', () => {
  it('still accepts the body the composer has always sent', async () => {
    const { captured, next } = await createPoll({
      question: 'Yes or no?',
      options: ['yes', 'no'],
      postId: `temp_${randomUUID()}`,
      isMultipleChoice: true,
      isAnonymous: false,
    });

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(201);
    const body = captured.body as { success: boolean; data: { _id: string; question: string; options: Array<{ text: string }> } };
    expect(body.success).toBe(true);
    expect(body.data.question).toBe('Yes or no?');
    expect(body.data.options.map((option) => option.text)).toEqual(['yes', 'no']);

    // The `temp_…` placeholder is stored as NULL, not as a post id.
    const [row] = await db.select().from(polls).where(eq(polls.id, body.data._id));
    expect(row.postId).toBeNull();
    expect(row.isMultipleChoice).toBe(true);
  });

  it('still accepts an ISO `endsAt`, and still refuses one no date can be read out of', async () => {
    const accepted = await createPoll({
      question: 'When?',
      options: ['now', 'later'],
      postId: `temp_${randomUUID()}`,
      endsAt: '2099-01-01T00:00:00.000Z',
    });
    expect(accepted.captured.status).toBe(201);

    const refused = await createPoll({
      question: 'When?',
      options: ['now', 'later'],
      postId: `temp_${randomUUID()}`,
      endsAt: 'not a date',
    });
    expect(refused.captured.status).toBe(400);
    expect(refused.captured.body).toMatchObject({ message: 'endsAt is not a valid date' });
  });

  it('refuses a `question` that is not a string, instead of writing it as a row', async () => {
    const { captured, authorId } = await createPoll({
      question: { $ne: null },
      options: ['yes', 'no'],
      postId: `temp_${randomUUID()}`,
    });

    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: 'Validation Error' });
    expect(await countPollsByAuthor(authorId)).toBe(0);
  });

  it('refuses an unbounded `options` array, instead of inserting a row per entry', async () => {
    const { captured, authorId } = await createPoll({
      question: 'Pick one',
      options: Array.from({ length: 500 }, (_unused, index) => `option ${index}`),
      postId: `temp_${randomUUID()}`,
    });

    expect(captured.status).toBe(400);
    expect(await countPollsByAuthor(authorId)).toBe(0);
  });

  it('refuses a non-boolean `isMultipleChoice`, instead of letting Postgres decide', async () => {
    const { captured } = await createPoll({
      question: 'Pick one',
      options: ['a', 'b'],
      postId: `temp_${randomUUID()}`,
      isMultipleChoice: 'banana',
    });

    expect(captured.status).toBe(400);
  });
});

describe('POST /polls/:id/vote body validation', () => {
  /** A poll with two options, owned by `author`, open until 2099. */
  async function seedOpenPoll(author: string) {
    const [poll] = await db
      .insert(polls)
      .values({
        question: 'Yes or no?',
        createdBy: author,
        endsAt: new Date('2099-01-01T00:00:00.000Z'),
        postId: null,
      })
      .returning();
    createdPollIds.push(poll.id);
    const choices = await db
      .insert(pollOptions)
      .values([
        { pollId: poll.id, position: 0, text: 'yes' },
        { pollId: poll.id, position: 1, text: 'no' },
      ])
      .returning();
    return { poll, choices };
  }

  it('still records a vote for a plain string `optionId`', async () => {
    const author = `author-${randomUUID()}`;
    const { poll, choices } = await seedOpenPoll(author);

    const { vote } = pollsController;
    const { captured, next } = await call(vote, {
      params: { id: poll.id },
      body: { optionId: choices[0].id },
      user: { id: author },
    });

    expect(next).not.toHaveBeenCalled();
    expect(captured.body).toMatchObject({ success: true });
    const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id));
    expect(votes).toHaveLength(1);
  });

  it('refuses an `optionId` wrapped in an array, instead of coercing it into a real one', async () => {
    const author = `author-${randomUUID()}`;
    const { poll, choices } = await seedOpenPoll(author);

    const { vote } = pollsController;
    const { captured } = await call(vote, {
      params: { id: poll.id },
      // `String(['<id>'])` is that id — the whole point of the refusal.
      body: { optionId: [choices[0].id] },
      user: { id: author },
    });

    expect(captured.status).toBe(400);
    const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id));
    expect(votes).toHaveLength(0);
  });
});
