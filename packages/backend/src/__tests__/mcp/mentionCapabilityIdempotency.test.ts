import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityTicketClaims } from '@oxyhq/contracts';
import { createMentionCapabilityEffectIdempotency } from '../../capabilities/capabilityEffectIdempotency.middleware';
import type { RequestWithMentionCapability } from '../../capabilities/capabilityAuth.middleware';

const claims: CapabilityTicketClaims = {
  iss: 'https://api.oxy.so',
  aud: 'mention-api',
  sub: 'agent-account',
  jti: 'ticket-create-post',
  iat: 1,
  exp: 2,
  runId: 'run-1',
  executionAuthorization: { kind: 'direct_request', id: 'authorization-1' },
  coordinator: { applicationId: 'alia', credentialId: 'alia-credential' },
  requesterAccountId: 'owner-account',
  ownerAccountId: 'owner-account',
  actor: { type: 'agent', accountId: 'agent-account' },
  resource: {
    appId: 'mention',
    effectiveAccountId: 'assigned-account',
    resourceType: 'mention_account',
    resourceId: 'assigned-account',
  },
  tool: 'create-post',
  capabilities: ['social.posts.publish'],
  limits: [],
  autonomy: 'execute_on_request',
};

function buildApp(reservation: { kind: 'reserved'; receiptId: string } | {
  kind: 'duplicate';
  status: 'succeeded';
  responseStatus: number;
}) {
  const reserve = vi.fn(async () => reservation);
  const finalize = vi.fn(async () => undefined);
  const effect = vi.fn((_request, response) => response.status(201).json({ ok: true }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as RequestWithMentionCapability).capability = { ticket: 'signed-ticket', claims };
    next();
  });
  app.use(createMentionCapabilityEffectIdempotency({ reserve, finalize }));
  app.post('/posts', effect);
  return { app, reserve, finalize, effect };
}

describe('Mention native capability effect idempotency', () => {
  it('binds a reservation to account, coordinator and real agent before publication', async () => {
    const { app, reserve, finalize, effect } = buildApp({
      kind: 'reserved',
      receiptId: 'receipt-1',
    });
    const response = await request(app)
      .post('/posts')
      .set('Idempotency-Key', 'run-1:create-post')
      .set('X-Oxy-Capability-Tool', 'create-post')
      .send({ content: { text: 'hello' } });

    expect(response.status).toBe(201);
    expect(effect).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      oxyUserId: 'assigned-account',
      clientId: 'capability:alia:alia-credential:agent-account',
      toolName: 'create-post',
      idempotencyKey: 'run-1:create-post',
    }));
    expect(finalize).toHaveBeenCalledWith('receipt-1', 201, false);
  });

  it('blocks a durable duplicate before the publication handler', async () => {
    const { app, effect } = buildApp({
      kind: 'duplicate',
      status: 'succeeded',
      responseStatus: 201,
    });
    const response = await request(app)
      .post('/posts')
      .set('Idempotency-Key', 'run-1:create-post')
      .set('X-Oxy-Capability-Tool', 'create-post')
      .send({ content: { text: 'hello' } });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('capability_effect_already_reserved');
    expect(effect).not.toHaveBeenCalled();
  });
});
