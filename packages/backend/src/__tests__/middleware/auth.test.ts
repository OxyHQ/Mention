import { describe, it, expect, vi } from 'vitest';
import type { Response, NextFunction } from 'express';
import { requireAuth, type AuthRequest } from '../../middleware/auth';

// --- helpers ----------------------------------------------------------------

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

// --- tests ------------------------------------------------------------------

describe('requireAuth middleware', () => {
  it('returns 401 when req.user is undefined', () => {
    const req = {} as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Unauthorized' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when req.user exists but id is an empty string', () => {
    const req = { user: { id: '' } } as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when req.user.id is present', () => {
    const req = { user: { id: 'user-123' } } as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('includes a message in the 401 body', () => {
    const req = {} as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAuth(req, res, next);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toHaveProperty('message');
    expect(typeof body.message).toBe('string');
  });
});
