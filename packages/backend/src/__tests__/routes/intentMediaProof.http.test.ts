import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxyServer, verifyCapabilityTicket } from '@oxy.so/core/server';
import type { CapabilityTicketClaims } from '@oxy.so/contracts';
import { createOptionalMentionCapabilityAuth } from '../../capabilities/capabilityAuth.middleware';
import { setRuntimeOxyClient, clearRuntimeOxyClient } from '../../runtime/oxyClient';
import intentMediaRoutes from '../../routes/intentMedia';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import { safetyRequesterFor } from '../../utils/safetyRequester';
import type { RequestSafetyContext } from '../../utils/safetyRequester';

vi.mock('../../middleware/rateLimitStore', () => ({
  RedisStore: class {
    init() {}
    async increment() {
      return { totalHits: 1, resetTime: undefined };
    }
    async decrement() {}
    async resetKey() {}
    async get() {
      return undefined;
    }
  },
}));
const keys = generateKeyPairSync('ed25519');
let authority: Server;
let oxy: OxyServer;
let app: express.Express;
let revoked = false;
let denyDownstream = false;
const writes: Array<{
  account: string;
  ticket: string | undefined;
  session: string | undefined;
  task: string | undefined;
}> = [];
const now = Math.floor(Date.now() / 1000);
const claims: CapabilityTicketClaims = {
  iss: 'https://api.oxy.so',
  aud: 'mention-api',
  sub: 'bot-actor',
  jti: 'original-ticket',
  iat: now,
  exp: now + 60,
  runId: 'alia-original-run',
  executionAuthorization: { kind: 'direct_request', id: 'original-execution' },
  coordinator: { applicationId: 'alia', credentialId: 'wl_alia' },
  requesterAccountId: 'original-person',
  ownerAccountId: 'bot-owner-other',
  actor: { type: 'agent', accountId: 'bot-actor' },
  resource: {
    appId: 'mention',
    effectiveAccountId: 'original-person',
    resourceType: 'mention_account',
    resourceId: 'original-person',
  },
  tool: 'upload-media',
  capabilities: ['social.media.create'],
  limits: [],
  autonomy: 'execute_on_request',
};
function ticketFor(value: CapabilityTicketClaims) {
  const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const bytes = `${encode({ alg: 'EdDSA', typ: 'OXY-CAPABILITY+JWT', kid: 'fixture' })}.${encode(value)}`;
  return `${bytes}.${sign(null, Buffer.from(bytes), keys.privateKey).toString('base64url')}`;
}
const ticket = ticketFor(claims);
const serviceToken = `e30.${Buffer.from(JSON.stringify({ exp: now + 300, authority: 'first_party' })).toString('base64url')}.fixture`;
beforeAll(async () => {
  const api = express();
  api.use(express.json());
  api.post('/auth/service-token/workload/challenge', (_req, res) =>
    res.json({ nonce: 'test-nonce' }),
  );
  api.post('/auth/service-token/workload', (req, res) => {
    expect(req.body.protocolVersion).toBe(2);
    res.json({ token: serviceToken, expiresIn: 300 });
  });
  api.post('/capabilities/tickets/introspect', (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${serviceToken}`);
    res.json({
      active: !revoked && req.body.ticket === ticket,
      claims,
      decision: { allowed: !revoked },
    });
  });
  api.post('/assets/service/user-media', express.raw({ type: '*/*' }), (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${serviceToken}`);
    const proof = req.header('x-oxy-capability-ticket');
    const account = req.header('x-owner-user-id');
    if (
      denyDownstream ||
      revoked ||
      proof !== ticket ||
      account !== claims.resource.effectiveAccountId
    ) {
      res.status(403).json({ error: 'original_operation_refused' });
      return;
    }
    writes.push({
      account,
      ticket: proof,
      session: req.header('x-oxy-requester-token'),
      task: req.header('x-oxy-task-id'),
    });
    res.json({
      data: { file: { id: 'file-original-person', mime: 'image/png', status: 'active' } },
    });
  });
  // Metadata enrichment is optional and contains no private requester identity.
  api.use((_req, res) => res.json({ data: [] }));
  authority = api.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => authority.once('listening', resolve));
  oxy = new OxyServer({
    baseURL: `http://127.0.0.1:${(authority.address() as AddressInfo).port}`,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'test-only',
      Token: 'temporary-test',
    }),
  });
  setRuntimeOxyClient(oxy);
  app = express();
  app.use(express.json());
  app.use(
    createOptionalMentionCapabilityAuth({
      verify: async (value) =>
        verifyCapabilityTicket(value, {
          issuer: claims.iss,
          audience: claims.aud,
          resolvePublicKey: () => keys.publicKey,
        }),
      introspect: async (value) => {
        const live = await oxy.agency.introspectCapabilityTicket(value);
        return live.active && live.decision?.allowed === true;
      },
    }),
  );
  app.use('/posts/intent-media', intentMediaRoutes);
});
beforeEach(() => {
  revoked = false;
  denyDownstream = false;
  writes.length = 0;
});
afterAll(async () => {
  clearRuntimeOxyClient();
  oxy.dispose();
  authority.closeAllConnections();
  await new Promise<void>((resolve) => authority.close(() => resolve()));
});
function upload(value = ticket) {
  return request(app)
    .post('/posts/intent-media')
    .set('Authorization', `Capability ${value}`)
    .set('X-Oxy-Capability-Tool', 'upload-media')
    .send({
      base64: Buffer.from('PNG!').toString('base64'),
      mimeType: 'image/png',
      ownerUserId: 'bot-owner-other',
    });
}
describe('Alia operation → Mention HTTP → shared Oxy Files requester proof', () => {
  it('keeps the original person through the bot and receiver workload without reusing the Alia task', async () => {
    const result = await upload();
    expect(result.status).toBe(200);
    expect(result.body.fileId).toBe('file-original-person');
    expect(writes).toEqual([
      { account: 'original-person', ticket, session: undefined, task: undefined },
    ]);
  });
  it('refuses a revoked original operation before touching Files', async () => {
    revoked = true;
    expect((await upload()).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it('does not retry or fall back to an owner header when downstream revalidation refuses', async () => {
    denyDownstream = true;
    expect((await upload()).status).toBe(502);
    expect(writes).toHaveLength(0);
  });
  it('rejects a signed ticket naming a different resource account', async () => {
    expect(
      (
        await upload(
          ticketFor({ ...claims, resource: { ...claims.resource, resourceId: 'other' } }),
        )
      ).status,
    ).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it('selects the same original proof for private graph and safety helpers', () => {
    const context: RequestSafetyContext = {
      user: { id: 'original-person' },
      capability: { ticket, claims },
    };
    expect(createScopedOxyClient(context)).toBeDefined();
    expect(safetyRequesterFor(context)).toEqual({ capabilityTicket: ticket });
  });
});
