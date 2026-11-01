import express from 'express';
import request from 'supertest';
import type { OxyServer } from '@oxy.so/core/server';
import { describe, expect, it, vi } from 'vitest';
import { supervisedActionForRequest } from '../../middleware/supervisedAction';
import { createRequireMcpOrOxyAuth } from '../../mcp/middleware/mcpAuth';

const equivalent = [
  {
    method: 'PATCH' as const,
    legacy: '/notifications/n/read',
    guarded: '/notifications/_viewer/n/read',
  },
  {
    method: 'PATCH' as const,
    legacy: '/notifications/n/archive',
    guarded: '/notifications/_viewer/n/archive',
  },
  {
    method: 'PATCH' as const,
    legacy: '/notifications/read-all',
    guarded: '/notifications/_viewer/read-all',
  },
  { method: 'DELETE' as const, legacy: '/notifications/n', guarded: '/notifications/_viewer/n' },
];

describe('supervised notification authorization through production middleware', () => {
  it.each(equivalent)(
    'passes the same content action for $guarded as $legacy',
    async ({ method, legacy, guarded }) => {
      const auth = vi.fn(
        (_options: unknown) =>
          (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
            next(),
      );
      const oxy = { middleware: { auth } } as unknown as OxyServer;
      const app = express();
      app.use('/api', createRequireMcpOrOxyAuth(oxy));
      app.use('/api', (_req, res) => res.sendStatus(204));
      for (const path of [legacy, guarded]) {
        const response = await request(app)
          [method.toLowerCase() as 'patch' | 'delete'](`/api${path}`)
          .set('Authorization', 'Bearer synthetic-supervised-session');
        expect(response.status).toBe(204);
        expect(auth.mock.lastCall?.[0]).toEqual(
          expect.objectContaining({ supervisedAction: 'content' }),
        );
      }
    },
  );

  it.each([
    ['GET', '/notifications/_viewer/n/read'],
    ['POST', '/notifications/_viewer/n/read'],
    ['PATCH', '/notifications/_viewer/n/unreviewed'],
    ['DELETE', '/notifications/_viewer/n/read'],
    ['POST', '/posts/p/collaborators/accept'],
    ['POST', '/posts/p/collaborators/_viewer/accept'],
    ['POST', '/posts/p/collaborators/decline'],
    ['POST', '/posts/p/collaborators/_viewer/decline'],
  ])('does not grant a new capability to %s %s', (method, path) => {
    expect(supervisedActionForRequest({ baseUrl: '/api', path, method })).toBeUndefined();
  });
});
