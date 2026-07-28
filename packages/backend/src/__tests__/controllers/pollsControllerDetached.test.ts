import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Poll handlers are registered DETACHED — `router.get('/:id', pollsController.getPoll)`
 * — so Express calls them with no receiver and `this` is `undefined` inside the
 * method. A handler that reached its sanitizer through `this` therefore threw on
 * the SUCCESS path only, which is how `GET /polls/:id` answered 500 in
 * production while its 400/404 branches looked perfectly healthy. `POST
 * /polls/:id/vote` was worse: the vote was already recorded when the response
 * blew up.
 *
 * These tests call the handlers exactly the way the router does — detached —
 * so the receiver is never accidentally supplied by the test itself.
 */

const pollFindById = vi.fn();
vi.mock('../../models/Poll', () => ({
  default: { findById: (...args: unknown[]) => pollFindById(...args) },
}));

vi.mock('../../models/Post', () => ({ default: {} }));

const recordVoteByOptionId = vi.fn();
vi.mock('../../services/PollVoteService', () => ({
  pollVoteService: {
    recordVoteByOptionId: (...args: unknown[]) => recordVoteByOptionId(...args),
  },
}));

import pollsController from '../../controllers/polls.controller';

const POLL_ID = '6a677d7c82d1d4a8f232583f';

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

function anonymousPoll() {
  return {
    isAnonymous: true,
    options: [{ _id: 'a', text: 'yes', votes: ['u1', 'u2'] }],
    toObject() {
      return { isAnonymous: this.isAnonymous, options: this.options };
    },
  };
}

describe('polls controller called the way Express calls it', () => {
  beforeEach(() => {
    pollFindById.mockReset();
    recordVoteByOptionId.mockReset();
  });

  it('GET /polls/:id answers with the sanitized poll', async () => {
    pollFindById.mockResolvedValue(anonymousPoll());
    const captured: CapturedResponse = { status: 200, body: undefined };
    const next = vi.fn();

    // Detached on purpose — this is the registration the router uses.
    const { getPoll } = pollsController;
    await getPoll(
      { params: { id: POLL_ID } } as never,
      makeRes(captured) as never,
      next as never,
    );

    expect(next).not.toHaveBeenCalled();
    expect(captured.body).toEqual({
      success: true,
      // Anonymous polls expose counts, never voter ids.
      data: { isAnonymous: true, options: [{ _id: 'a', text: 'yes', votes: 2 }] },
    });
  });

  it('POST /polls/:id/vote answers instead of 500-ing after recording the vote', async () => {
    recordVoteByOptionId.mockResolvedValue({ ok: true, poll: anonymousPoll() });
    const captured: CapturedResponse = { status: 200, body: undefined };
    const next = vi.fn();

    const { vote } = pollsController;
    await vote(
      { params: { id: POLL_ID }, body: { optionId: 'a' }, user: { id: 'u1' } } as never,
      makeRes(captured) as never,
      next as never,
    );

    expect(next).not.toHaveBeenCalled();
    expect(captured.body).toEqual({
      success: true,
      data: { isAnonymous: true, options: [{ _id: 'a', text: 'yes', votes: 2 }] },
    });
  });
});
