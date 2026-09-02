import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createMcpEffectIdempotency } from '../../mcp/middleware/mcpEffectIdempotency';
import type { OxyAuthRequestWithMcp } from '../../mcp/middleware/mcpAuth';

const KEY = `mcp:${'a'.repeat(64)}`;

function buildApp(input: {
  reserve: ReturnType<typeof vi.fn>;
  finalize?: ReturnType<typeof vi.fn>;
  effect?: ReturnType<typeof vi.fn>;
}) {
  const finalize = input.finalize ?? vi.fn().mockResolvedValue(undefined);
  const effect = input.effect ?? vi.fn((_req, res) => res.status(201).json({ ok: true }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as OxyAuthRequestWithMcp).mcp = {
      authMode: 'central',
      jti: 'token-1',
      scope: 'social.posts.publish',
      clientId: 'client-1',
      primaryUserId: 'owner-1',
      activeUserId: 'account-1',
    };
    next();
  });
  app.use(createMcpEffectIdempotency({
    reserve: input.reserve,
    finalize,
  }));
  app.post('/posts', effect);
  app.get('/posts', (_req, res) => res.json({ ok: true }));
  return { app, effect, finalize };
}

describe('MCP effect idempotency middleware', () => {
  it('reserves and finalizes a valid effect before and after the domain handler', async () => {
    const reserve = vi.fn().mockResolvedValue({ kind: 'reserved', receiptId: 'receipt-1' });
    const { app, effect, finalize } = buildApp({ reserve });

    const response = await request(app)
      .post('/posts')
      .set('Idempotency-Key', KEY)
      .set('X-Oxy-MCP-Tool', 'create-post')
      .send({ content: { text: 'hello' } });

    expect(response.status).toBe(201);
    expect(effect).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      oxyUserId: 'account-1',
      clientId: 'client-1',
      toolName: 'create-post',
      idempotencyKey: KEY,
    }));
    expect(finalize).toHaveBeenCalledWith('receipt-1', 201, false);
  });

  it('refuses a write before the domain handler when the transport key is absent', async () => {
    const reserve = vi.fn();
    const { app, effect } = buildApp({ reserve });

    const response = await request(app)
      .post('/posts')
      .set('X-Oxy-MCP-Tool', 'create-post')
      .send({ content: { text: 'hello' } });

    expect(response.status).toBe(428);
    expect(effect).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('blocks a durable duplicate without entering the domain handler', async () => {
    const reserve = vi.fn().mockResolvedValue({
      kind: 'duplicate',
      status: 'succeeded',
      responseStatus: 201,
    });
    const { app, effect } = buildApp({ reserve });

    const response = await request(app)
      .post('/posts')
      .set('Idempotency-Key', KEY)
      .set('X-Oxy-MCP-Tool', 'create-post')
      .send({ content: { text: 'hello' } });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('mcp_effect_already_reserved');
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects a tool name that does not own the requested route', async () => {
    const reserve = vi.fn();
    const { app, effect } = buildApp({ reserve });

    const response = await request(app)
      .post('/posts')
      .set('Idempotency-Key', KEY)
      .set('X-Oxy-MCP-Tool', 'like-post')
      .send({ content: { text: 'hello' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('mcp_tool_route_mismatch');
    expect(effect).not.toHaveBeenCalled();
  });

  it('does not touch safe reads', async () => {
    const reserve = vi.fn();
    const { app } = buildApp({ reserve });

    expect((await request(app).get('/posts')).status).toBe(200);
    expect(reserve).not.toHaveBeenCalled();
  });
});
