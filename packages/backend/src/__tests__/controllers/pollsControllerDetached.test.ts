/**
 * The polls controller, called the way Express calls it, against REAL Postgres.
 *
 * Two separate things are being held down here.
 *
 * **The detached receiver.** Poll handlers are registered detached —
 * `router.get('/:id', pollsController.getPoll)` — so Express calls them with no
 * receiver and `this` is `undefined` inside the method. A handler that reached
 * its serializer through `this` therefore threw on the SUCCESS path only, which
 * is how `GET /polls/:id` answered 500 in production while its 400/404 branches
 * looked perfectly healthy. `POST /polls/:id/vote` was worse: the vote was
 * already recorded when the response blew up. Every handler below is pulled off
 * the controller before it is called, so the receiver is never accidentally
 * supplied by the test itself.
 *
 * **The wire format.** Storage moved from one document with an embedded option
 * array to three tables and the client did not: `frontend/services/pollService.ts`
 * reads `_id` on the poll AND on every option, treats `opt.votes` as an array of
 * voter ids, and names the timestamps `created_at`/`updated_at`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import pollsController from '../../controllers/polls.controller';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '@oxyhq/db';
import { pollOptions, pollVotes, polls } from '../../db/schema/polls';
import { posts } from '../../db/schema/posts';
import { postHydrationService } from '../../services/PostHydrationService';

let db: Database;
const createdPollIds: string[] = [];
const createdPostIds: string[] = [];

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

/** Run a detached handler and return what it answered. */
async function call(
  handler: (req: never, res: never, next: never) => Promise<unknown>,
  req: Record<string, unknown>,
): Promise<{ captured: CapturedResponse; next: ReturnType<typeof vi.fn> }> {
  const captured: CapturedResponse = { status: 200, body: undefined };
  const next = vi.fn();
  await handler(req as never, makeRes(captured) as never, next as never);
  return { captured, next };
}

async function seedPost(oxyUserId: string): Promise<string> {
  const [post] = await db.insert(posts).values({ oxyUserId }).returning({ id: posts.id });
  createdPostIds.push(post.id);
  return post.id;
}

async function seedPoll(options: {
  createdBy: string;
  isAnonymous?: boolean;
  isMultipleChoice?: boolean;
  postId?: string | null;
  endsAt?: Date;
}) {
  const [poll] = await db
    .insert(polls)
    .values({
      question: 'Yes or no?',
      createdBy: options.createdBy,
      endsAt: options.endsAt ?? new Date('2099-01-01T00:00:00.000Z'),
      isAnonymous: options.isAnonymous ?? false,
      isMultipleChoice: options.isMultipleChoice ?? false,
      postId: options.postId ?? null,
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

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (createdPollIds.length > 0) {
    await db.delete(polls).where(inArray(polls.id, createdPollIds.splice(0)));
  }
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('polls controller called the way Express calls it', () => {
  it('GET /polls/:id answers with the sanitized poll', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    const acl = vi.spyOn(postHydrationService, 'canViewerReadPostId').mockResolvedValueOnce(true);
    const { poll, choices } = await seedPoll({ createdBy: author, isAnonymous: true, postId });
    await db.insert(pollVotes).values([
      { pollId: poll.id, optionId: choices[0].id, userId: 'u1' },
      { pollId: poll.id, optionId: choices[0].id, userId: 'u2' },
    ]);

    // Detached on purpose — this is the registration the router uses.
    const { getPoll } = pollsController;
    const { captured, next } = await call(getPoll, { params: { id: poll.id }, user: { id: 'u1' } });

    expect(next).not.toHaveBeenCalled();
    const body = captured.body as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data._id).toBe(poll.id);
    // Anonymous polls expose counts, never voter ids.
    expect(body.data.options).toEqual([
      { _id: choices[0].id, text: 'yes', votes: 2 },
      { _id: choices[1].id, text: 'no', votes: 0 },
    ]);
    expect(acl).toHaveBeenCalledWith(postId, 'u1');
  });

  it('POST /polls/:id/vote answers instead of 500-ing after recording the vote', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    vi.spyOn(postHydrationService, 'canViewerReadPostId').mockResolvedValueOnce(true);
    const { poll, choices } = await seedPoll({ createdBy: author, postId });

    const { vote } = pollsController;
    const { captured, next } = await call(vote, {
      params: { id: poll.id },
      body: { optionId: choices[0].id },
      user: { id: 'u1' },
    });

    expect(next).not.toHaveBeenCalled();
    const body = captured.body as { success: boolean; data: { options: Array<{ votes: string[] }> } };
    expect(body.success).toBe(true);
    // Not anonymous, so the voter ids come back as the array the client expects.
    expect(body.data.options[0].votes).toEqual(['u1']);
    expect(await db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id))).toHaveLength(1);
  });

  it('conceals an attached poll when the owning post ACL refuses the viewer', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    const { poll } = await seedPoll({ createdBy: author, postId });
    vi.spyOn(postHydrationService, 'canViewerReadPostId').mockResolvedValueOnce(false);

    const { getPoll } = pollsController;
    const { captured } = await call(getPoll, {
      params: { id: poll.id },
      user: { id: 'intruder' },
    });

    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ error: 'Not found', message: 'Poll not found' });
  });

  it('refuses voting before writing when the owning post ACL refuses the viewer', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    const { poll, choices } = await seedPoll({ createdBy: author, postId });
    vi.spyOn(postHydrationService, 'canViewerReadPostId').mockResolvedValueOnce(false);

    const { vote } = pollsController;
    const { captured } = await call(vote, {
      params: { id: poll.id },
      body: { optionId: choices[0].id },
      user: { id: 'intruder' },
    });

    expect(captured.status).toBe(404);
    expect(await db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id))).toHaveLength(0);
  });
});

describe('the id guards — a documented 400, widened to both live shapes', () => {
  it.each([
    ['getPoll', 'getPoll' as const],
    ['getResults', 'getResults' as const],
    ['deletePoll', 'deletePoll' as const],
  ])('%s answers 400 for a malformed id', async (_label, key) => {
    const handler = pollsController[key];
    const { captured } = await call(handler, {
      params: { id: 'definitely-not-an-id' },
      user: { id: 'u1' },
    });
    expect(captured.status).toBe(400);
  });

  it('accepts a uuid v7 id and answers 404 when it names nothing', async () => {
    // `@oxyhq/db` exists for exactly this: the 400 stays a contract, but a poll
    // created after the cutover carries a uuid v7 and must not be rejected as
    // malformed.
    const { getPoll } = pollsController;
    const { captured } = await call(getPoll, { params: { id: uuidv7() }, user: { id: 'u1' } });
    expect(captured.status).toBe(404);
  });
});

describe('createPoll', () => {
  it('stores the poll, its options in author order, and links the post', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);

    const { createPoll } = pollsController;
    const { captured, next } = await call(createPoll, {
      body: { question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'], postId },
      user: { id: author },
    });

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(201);
    const body = captured.body as { data: Record<string, unknown> };
    const pollId = String(body.data._id);
    createdPollIds.push(pollId);

    expect(body.data.postId).toBe(postId);
    expect(body.data.createdBy).toBe(author);
    // Mongoose named these `created_at`/`updated_at`, and the client reads them.
    expect(body.data.created_at).toBeInstanceOf(Date);
    expect(body.data.updated_at).toBeInstanceOf(Date);
    expect(body.data).not.toHaveProperty('__v');
    expect((body.data.options as Array<{ text: string }>).map((o) => o.text)).toEqual([
      'Tabs',
      'Spaces',
    ]);

    const stored = await db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId));
    expect(stored.map((option) => option.position).sort()).toEqual([0, 1]);

    // `metadata.pollId`/`content.pollId` were two mirrors of one fact; the
    // schema keeps a single `posts.content_poll_id`.
    const [post] = await db
      .select({ contentPollId: posts.contentPollId })
      .from(posts)
      .where(eq(posts.id, postId));
    expect(post.contentPollId).toBe(pollId);
  });

  it('stores a `temp_` placeholder postId as NULL and omits it from the response', async () => {
    const author = `author-${randomUUID()}`;
    const { createPoll } = pollsController;
    const { captured } = await call(createPoll, {
      body: { question: 'Q', options: ['a', 'b'], postId: `temp_${randomUUID()}` },
      user: { id: author },
    });

    expect(captured.status).toBe(201);
    const body = captured.body as { data: Record<string, unknown> };
    const pollId = String(body.data._id);
    createdPollIds.push(pollId);

    expect(body.data).not.toHaveProperty('postId');
    const [row] = await db.select({ postId: polls.postId }).from(polls).where(eq(polls.id, pollId));
    expect(row.postId).toBeNull();
  });

  it('answers 404 for a post id that names nothing, not 400', async () => {
    // The `try/catch` that answered 400 'Invalid post ID format' existed only to
    // convert a Mongoose `CastError`. A `text` id that matches no row reaches the
    // 404, which is the more useful of the two answers.
    const { createPoll } = pollsController;
    const { captured } = await call(createPoll, {
      body: { question: 'Q', options: ['a', 'b'], postId: 'not-a-real-post' },
      user: { id: `author-${randomUUID()}` },
    });
    expect(captured.status).toBe(404);
  });

  it('refuses to attach a poll to someone else\'s post', async () => {
    const owner = `author-${randomUUID()}`;
    const postId = await seedPost(owner);
    const { createPoll } = pollsController;
    const { captured } = await call(createPoll, {
      body: { question: 'Q', options: ['a', 'b'], postId },
      user: { id: `intruder-${randomUUID()}` },
    });
    expect(captured.status).toBe(403);
  });

  it.each([
    ['a blank option', { question: 'Q', options: ['a', ''], postId: 'temp_x' }],
    ['an uncastable endsAt', { question: 'Q', options: ['a', 'b'], postId: 'temp_x', endsAt: 'soon' }],
    ['a missing postId', { question: 'Q', options: ['a', 'b'] }],
  ])('answers 400 for %s', async (_label, body) => {
    /**
     * These are the Mongoose validators that had no Postgres counterpart —
     * `required` treats `''` as missing, `postId` was `required`, and an
     * uncastable date was a `ValidationError`. Re-applied at the call site, they
     * keep the same 400 out the front.
     */
    const { createPoll } = pollsController;
    const { captured } = await call(createPoll, { body, user: { id: `author-${randomUUID()}` } });
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: 'Validation Error' });
  });
});

describe('getResults', () => {
  it('reports per-option counts and percentages', async () => {
    const author = `author-${randomUUID()}`;
    const { poll, choices } = await seedPoll({ createdBy: author });
    await db.insert(pollVotes).values([
      { pollId: poll.id, optionId: choices[0].id, userId: 'u1' },
      { pollId: poll.id, optionId: choices[0].id, userId: 'u2' },
      { pollId: poll.id, optionId: choices[1].id, userId: 'u3' },
    ]);

    // Read as the CREATOR of a poll no post owns: that branch of the gate is
    // decided from two columns, so this stays the percentages test rather than
    // turning into an Oxy round trip nothing here can serve.
    const { getResults } = pollsController;
    const { captured } = await call(getResults, {
      params: { id: poll.id },
      user: { id: author },
    });
    const body = captured.body as {
      data: {
        id: string;
        totalVotes: number;
        isEnded: boolean;
        results: Array<{ id: string; votes: number; percentage: number }>;
      };
    };

    expect(body.data.id).toBe(poll.id);
    expect(body.data.totalVotes).toBe(3);
    expect(body.data.isEnded).toBe(false);
    expect(body.data.results.map((r) => r.votes)).toEqual([2, 1]);
    expect(body.data.results[0].percentage).toBeCloseTo(66.67, 1);
  });

  it('conceals results when the owning post ACL refuses the viewer', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    const { poll } = await seedPoll({ createdBy: author, postId });
    vi.spyOn(postHydrationService, 'canViewerReadPostId').mockResolvedValueOnce(false);

    const { getResults } = pollsController;
    const { captured } = await call(getResults, {
      params: { id: poll.id },
      user: { id: 'intruder' },
    });

    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ error: 'Not found', message: 'Poll not found' });
  });

  it('conceals results when the ACL cannot be answered at all', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    const { poll } = await seedPoll({ createdBy: author, postId });
    vi.spyOn(postHydrationService, 'canViewerReadPostId').mockRejectedValueOnce(
      new Error('Oxy could not resolve the delegated blocked privacy context'),
    );

    const { getResults } = pollsController;
    const { captured } = await call(getResults, {
      params: { id: poll.id },
      user: { id: 'intruder' },
    });

    // Fails closed rather than 500-ing: an unanswerable ACL is not a yes.
    expect(captured.status).toBe(404);
  });
});

describe('deletePoll', () => {
  it('unlinks the post, deletes the poll, and cascades its options and votes', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    const { poll, choices } = await seedPoll({ createdBy: author, postId });
    await db.update(posts).set({ contentPollId: poll.id }).where(eq(posts.id, postId));
    await db.insert(pollVotes).values({ pollId: poll.id, optionId: choices[0].id, userId: 'u1' });

    const { deletePoll } = pollsController;
    const { captured } = await call(deletePoll, {
      params: { id: poll.id },
      user: { id: author },
    });

    expect(captured.body).toEqual({ success: true, message: 'Poll deleted successfully' });
    expect(await db.select().from(polls).where(eq(polls.id, poll.id))).toEqual([]);
    expect(await db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id))).toEqual([]);
    expect(await db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id))).toEqual([]);
    const [post] = await db
      .select({ contentPollId: posts.contentPollId })
      .from(posts)
      .where(eq(posts.id, postId));
    expect(post.contentPollId).toBeNull();
    createdPollIds.pop();
  });

  it('deletes a poll that was never attached to a post', async () => {
    // Mongo stored a `temp_` placeholder here, and `Post.findByIdAndUpdate`
    // threw a `CastError` on it — so deleting a never-attached poll answered
    // 500. A NULL `post_id` simply skips the unlink.
    const author = `author-${randomUUID()}`;
    const { poll } = await seedPoll({ createdBy: author, postId: null });

    const { deletePoll } = pollsController;
    const { captured } = await call(deletePoll, { params: { id: poll.id }, user: { id: author } });

    expect(captured.status).toBe(200);
    expect(await db.select().from(polls).where(eq(polls.id, poll.id))).toEqual([]);
    createdPollIds.pop();
  });

  it('lets only the creator delete', async () => {
    const author = `author-${randomUUID()}`;
    const { poll } = await seedPoll({ createdBy: author });
    const { deletePoll } = pollsController;
    const { captured } = await call(deletePoll, {
      params: { id: poll.id },
      user: { id: `stranger-${randomUUID()}` },
    });
    expect(captured.status).toBe(403);
    expect(await db.select().from(polls).where(eq(polls.id, poll.id))).toHaveLength(1);
  });
});

describe('updatePollPostId', () => {
  it('links both directions in one write', async () => {
    const author = `author-${randomUUID()}`;
    const postId = await seedPost(author);
    const { poll } = await seedPoll({ createdBy: author, postId: null });

    const { updatePollPostId } = pollsController;
    const { captured } = await call(updatePollPostId, {
      params: { id: poll.id },
      body: { postId },
      user: { id: author },
    });

    expect(captured.status).toBe(200);
    const body = captured.body as { data: Record<string, unknown> };
    expect(body.data.postId).toBe(postId);

    const [row] = await db.select({ postId: polls.postId }).from(polls).where(eq(polls.id, poll.id));
    expect(row.postId).toBe(postId);
    const [post] = await db
      .select({ contentPollId: posts.contentPollId })
      .from(posts)
      .where(eq(posts.id, postId));
    expect(post.contentPollId).toBe(poll.id);
  });

  it('answers 400 when either id is malformed', async () => {
    const author = `author-${randomUUID()}`;
    const { poll } = await seedPoll({ createdBy: author });
    const { updatePollPostId } = pollsController;
    const { captured } = await call(updatePollPostId, {
      params: { id: poll.id },
      body: { postId: 'nope' },
      user: { id: author },
    });
    expect(captured.status).toBe(400);
  });
});
