import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from '../../db/schema/columns';
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

describe('validateBody', () => {
  it('calls next() and replaces req.body when input is valid', () => {
    const schema = schemas.likeRequest;
    const req = makeReq({ postId: 'abc123' });
    const res = makeRes();
    const next = makeNext();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toMatchObject({ postId: 'abc123' });
  });

  it('returns 400 with VALIDATION_ERROR when body is missing required fields', () => {
    const schema = schemas.likeRequest;
    const req = makeReq({});
    const res = makeRes();
    const next = makeNext();

    validateBody(schema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const body = getJsonBody(res) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  it('returns 400 when postId is an empty string (fails min(1))', () => {
    const schema = schemas.likeRequest;
    const req = makeReq({ postId: '' });
    const res = makeRes();
    const next = makeNext();

    validateBody(schema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('applies defaults — likeRequest type defaults to "post"', () => {
    const schema = schemas.likeRequest;
    const req = makeReq({ postId: 'abc123' });
    const res = makeRes();
    const next = makeNext();

    validateBody(schema)(req, res, next);

    expect(req.body.type).toBe('post');
  });
});

// --- validateBody with createPost schema ------------------------------------

describe('validateBody — createPost schema', () => {
  it('accepts a minimal createPost body (all fields optional/defaulted)', () => {
    const req = makeReq({});
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.createPost)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    // defaults applied
    expect(req.body.visibility).toBe('public');
    expect(req.body.replyPermission).toEqual(['anyone']);
    expect(req.body.reviewReplies).toBe(false);
    expect(req.body.quotesDisabled).toBe(false);
  });

  it('accepts a createPost body with content text', () => {
    const req = makeReq({ content: { text: 'Hello world' }, visibility: 'public' });
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.createPost)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body.content.text).toBe('Hello world');
  });

  it('rejects createPost when visibility is an unknown value', () => {
    const req = makeReq({ visibility: 'secret' });
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.createPost)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects createPost when content text exceeds 25000 characters', () => {
    const req = makeReq({ content: { text: 'x'.repeat(25001) } });
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.createPost)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects createPost when media array has more than 10 items', () => {
    const media = Array.from({ length: 11 }, (_, i) => ({ id: `file-${i}`, type: 'image' }));
    const req = makeReq({ content: { media } });
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.createPost)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// --- validateBody with likeRequest schema -----------------------------------

describe('validateBody — likeRequest schema', () => {
  it('accepts valid likeRequest body', () => {
    const req = makeReq({ postId: 'post-abc', type: 'post' });
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.likeRequest)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects likeRequest when postId is missing', () => {
    const req = makeReq({ type: 'post' });
    const res = makeRes();
    const next = makeNext();

    validateBody(schemas.likeRequest)(req, res, next);

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
