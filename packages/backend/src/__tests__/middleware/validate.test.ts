import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { uuidv7 } from '@oxyhq/db';
import { validateBody, validateObjectId, schemas } from '../../middleware/validate';
import { ErrorCodes } from '../../utils/apiResponse';

// --- helpers ----------------------------------------------------------------

/**
 * A 24-char ObjectId hex — one of the two shapes `isLiveEntityId` accepts, and
 * the one every pre-cutover row still carries. Generated here rather than taken
 * from a driver: the middleware matches a regex, so the only property a fixture
 * needs is the shape.
 */
function objectIdHex(): string {
  return randomBytes(12).toString('hex');
}

function makeReq(body: unknown = {}, params: Record<string, string> = {}): Request {
  return { body, params } as unknown as Request;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

function getJsonBody(res: Response): unknown {
  return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

// --- validateBody -----------------------------------------------------------

/**
 * A schema declared HERE, not borrowed from `schemas`.
 *
 * These cases are about `validateBody` — that it calls `next()`, that it
 * replaces `req.body` with the PARSED value, that a failure is a 400 in the
 * `ErrorCodes.VALIDATION_ERROR` envelope. They used to borrow `schemas.createPost`
 * and `schemas.likeRequest`, two schemas no route ever mounted, which made this
 * file the only thing keeping them alive. A fixture states the property under
 * test without pretending to describe a request anybody sends.
 */
const fixtureSchema = z.object({
  postId: z.string().min(1),
  type: z.string().optional().default('post'),
});

describe('validateBody', () => {
  it('calls next() and replaces req.body when input is valid', () => {
    const req = makeReq({ postId: 'abc123' });
    const res = makeRes();
    const next = makeNext();

    validateBody(fixtureSchema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toMatchObject({ postId: 'abc123' });
  });

  it('returns 400 with VALIDATION_ERROR when body is missing required fields', () => {
    const req = makeReq({});
    const res = makeRes();
    const next = makeNext();

    validateBody(fixtureSchema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const body = getJsonBody(res) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  it('returns 400 when a string field is empty (fails min(1))', () => {
    const req = makeReq({ postId: '' });
    const res = makeRes();
    const next = makeNext();

    validateBody(fixtureSchema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('applies defaults, which is why the parsed value replaces req.body', () => {
    const req = makeReq({ postId: 'abc123' });
    const res = makeRes();
    const next = makeNext();

    validateBody(fixtureSchema)(req, res, next);

    expect(req.body.type).toBe('post');
  });

  it('names the failing PATH in the message, which is what the caller reads', () => {
    const req = makeReq({ userIds: [] });
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.manageFeedMembers)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = getJsonBody(res) as { error: { message: string } };
    expect(body.error.message).toContain('userIds');
  });
});

// --- validateBody with the schemas routes actually mount ---------------------

describe('validateBody — the mounted schemas', () => {
  it('accepts and refuses a feed review by its rating bounds', () => {
    const ok = makeRes();
    const okNext = makeNext();
    validateBody(schemas.createFeedReview)(makeReq({ rating: 5, reviewText: 'good' }), ok, okNext);
    expect(okNext).toHaveBeenCalledOnce();

    for (const rating of [0, 6, 2.5, '5']) {
      const res = makeRes();
      const next = makeNext();
      validateBody(schemas.createFeedReview)(makeReq({ rating }), res, next);
      expect(next, `expected rating ${JSON.stringify(rating)} to be rejected`).not.toHaveBeenCalled();
    }
  });

  it('bounds a member-management request at 100 ids', () => {
    const ok = makeRes();
    const okNext = makeNext();
    validateBody(schemas.manageFeedMembers)(
      makeReq({ userIds: Array.from({ length: 100 }, (_, i) => `u${i}`) }),
      ok,
      okNext,
    );
    expect(okNext).toHaveBeenCalledOnce();

    const res = makeRes();
    const next = makeNext();
    validateBody(schemas.manageFeedMembers)(
      makeReq({ userIds: Array.from({ length: 101 }, (_, i) => `u${i}`) }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// --- validateObjectId -------------------------------------------------------

describe('validateObjectId middleware', () => {
  it('calls next() when the param is a valid ObjectId', () => {
    const validId = objectIdHex();
    const req = makeReq({}, { id: validId });
    const res = makeRes();
    const next = makeNext();

    validateObjectId('id')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 400 when the param is not a valid ObjectId', () => {
    const req = makeReq({}, { id: 'not-an-objectid' });
    const res = makeRes();
    const next = makeNext();

    validateObjectId('id')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    const body = getJsonBody(res) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  it('returns 400 when the param is missing entirely', () => {
    const req = makeReq({}, {});
    const res = makeRes();
    const next = makeNext();

    validateObjectId('id')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a custom param name', () => {
    const validId = objectIdHex();
    const req = makeReq({}, { postId: validId });
    const res = makeRes();
    const next = makeNext();

    validateObjectId('postId')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 400 when custom param is present but invalid', () => {
    const req = makeReq({}, { postId: '123' });
    const res = makeRes();
    const next = makeNext();

    validateObjectId('postId')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = getJsonBody(res) as { error: { message: string } };
    expect(body.error.message).toContain('postId');
  });

  it('accepts a uuid v7, the id shape every row created after the cutover has', () => {
    /**
     * A 24-hex-only check here is not fail-open, it is fail-CLOSED — and total:
     * every route behind it (`/labelers/:id`, `/custom-feeds/:id`,
     * `/mute-words/:id`) would 400 for every entity created after the cutover,
     * before any handler runs.
     */
    const req = makeReq({}, { id: uuidv7() });
    const res = makeRes();
    const next = makeNext();

    validateObjectId('id')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still rejects a shape neither store ever produced', () => {
    /**
     * The vacuity floor for the case above: widening to two shapes must not
     * degrade into accepting anything. A v4 UUID is the sharp case — nothing in
     * this schema generates one, so it names no row and is a client error.
     */
    for (const id of ['not-an-id', '', '123', 'f47ac10b-58cc-4372-a567-0e02b2c3d479']) {
      const res = makeRes();
      const next = makeNext();
      validateObjectId('id')(makeReq({}, { id }), res, next);
      expect(next, `expected ${JSON.stringify(id)} to be rejected`).not.toHaveBeenCalled();
    }
  });
});
