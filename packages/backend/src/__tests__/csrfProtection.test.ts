import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { csrfProtection } from '../middleware/csrfProtection';

vi.mock('../utils/allowedOrigins', () => ({
  isAllowedOrigin: (origin: string) => origin === 'https://mention.earth',
}));

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn() },
}));

function runMiddleware(method: string, headers: Request['headers'] = {}) {
  const req = {
    method,
    headers,
    originalUrl: '/posts',
    url: '/posts',
  } as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  csrfProtection(req, res, next);

  return { res, next };
}

describe('csrfProtection', () => {
  it('allows safe requests without checking Origin', () => {
    const { res, next } = runMiddleware('GET', { origin: 'https://evil.example' });

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows state-changing requests from an allowed Origin', () => {
    const { res, next } = runMiddleware('POST', { origin: 'https://mention.earth' });

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks state-changing requests from a disallowed Origin', () => {
    const { res, next } = runMiddleware('POST', { origin: 'https://evil.example' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('uses Referer origin when Origin is absent', () => {
    const { res, next } = runMiddleware('DELETE', { referer: 'https://evil.example/form.html' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows headerless state-changing requests for non-browser clients', () => {
    const { res, next } = runMiddleware('POST');

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
