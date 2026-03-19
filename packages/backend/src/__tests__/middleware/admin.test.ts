/**
 * Tests for the admin middleware.
 *
 * The admin module reads ADMIN_USER_IDS from the environment at import time,
 * so each test group that needs a specific env must use vi.resetModules() to
 * force a fresh import with the desired env variable value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../types/auth';

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

// --- isAdmin ----------------------------------------------------------------

describe('isAdmin', () => {
  const originalEnv = process.env.ADMIN_USER_IDS;

  afterEach(() => {
    process.env.ADMIN_USER_IDS = originalEnv;
    vi.resetModules();
  });

  it('returns true for a user ID that is in ADMIN_USER_IDS', async () => {
    process.env.ADMIN_USER_IDS = 'admin-user-1,admin-user-2';
    vi.resetModules();
    const { isAdmin } = await import('../../middleware/admin');
    expect(isAdmin('admin-user-1')).toBe(true);
    expect(isAdmin('admin-user-2')).toBe(true);
  });

  it('returns false for a user ID not in ADMIN_USER_IDS', async () => {
    process.env.ADMIN_USER_IDS = 'admin-user-1';
    vi.resetModules();
    const { isAdmin } = await import('../../middleware/admin');
    expect(isAdmin('regular-user')).toBe(false);
  });

  it('returns false for any ID when ADMIN_USER_IDS is unset', async () => {
    delete process.env.ADMIN_USER_IDS;
    vi.resetModules();
    const { isAdmin } = await import('../../middleware/admin');
    expect(isAdmin('anyone')).toBe(false);
  });

  it('handles whitespace in the env var gracefully', async () => {
    process.env.ADMIN_USER_IDS = ' admin-user-1 , admin-user-2 ';
    vi.resetModules();
    const { isAdmin } = await import('../../middleware/admin');
    expect(isAdmin('admin-user-1')).toBe(true);
    expect(isAdmin('admin-user-2')).toBe(true);
  });

  it('is case-sensitive — does not match different casing', async () => {
    process.env.ADMIN_USER_IDS = 'Admin-User-1';
    vi.resetModules();
    const { isAdmin } = await import('../../middleware/admin');
    expect(isAdmin('admin-user-1')).toBe(false);
  });
});

// --- requireAdmin -----------------------------------------------------------

describe('requireAdmin middleware', () => {
  const originalEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.ADMIN_USER_IDS = originalEnv;
  });

  it('returns 401 when req.user is not set (unauthenticated)', async () => {
    process.env.ADMIN_USER_IDS = 'admin-1';
    vi.resetModules();
    const { requireAdmin } = await import('../../middleware/admin');

    const req = {} as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user is authenticated but not an admin', async () => {
    process.env.ADMIN_USER_IDS = 'admin-1';
    vi.resetModules();
    const { requireAdmin } = await import('../../middleware/admin');

    const req = { user: { id: 'regular-user' } } as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error).toBe('Forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when user is an admin', async () => {
    process.env.ADMIN_USER_IDS = 'admin-1,admin-2';
    vi.resetModules();
    const { requireAdmin } = await import('../../middleware/admin');

    const req = { user: { id: 'admin-1' } } as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('403 response body includes a message field', async () => {
    process.env.ADMIN_USER_IDS = 'admin-1';
    vi.resetModules();
    const { requireAdmin } = await import('../../middleware/admin');

    const req = { user: { id: 'non-admin' } } as AuthRequest;
    const res = makeRes();
    const next = makeNext();

    requireAdmin(req, res, next);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toHaveProperty('message');
    expect(typeof body.message).toBe('string');
  });

  it('allows all admin IDs from a multi-value env', async () => {
    process.env.ADMIN_USER_IDS = 'user-a,user-b,user-c';
    vi.resetModules();
    const { requireAdmin } = await import('../../middleware/admin');

    for (const adminId of ['user-a', 'user-b', 'user-c']) {
      const req = { user: { id: adminId } } as AuthRequest;
      const res = makeRes();
      const next = makeNext();

      requireAdmin(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    }
  });
});
