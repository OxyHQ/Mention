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
import { getBlockedUserIds, OxyPrivacyAuthorizationError } from '../../utils/privacyHelpers';
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
  forwarded: Array<string | undefined>;
}> = [];
/** What Oxy admits Mention to act for on its declared authority (ADR 0066). */
const actsFor = new Set(['original-person', 'org-account|original-person']);
function admitted(req: express.Request): boolean {
  const account = req.header('x-oxy-user-id');
  const person = req.header('x-oxy-requester-id');
  const forwarded = [
    req.header('x-oxy-capability-ticket'),
    req.header('x-oxy-requester-context'),
    req.header('x-oxy-requester-token'),
    req.header('x-oxy-task-id'),
  ];
  return (
    !!account &&
    forwarded.every((value) => value === undefined) &&
    actsFor.has(person ? `${account}|${person}` : account)
  );
}
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
    const account = req.header('x-owner-user-id');
    if (
      denyDownstream ||
      revoked ||
      !admitted(req) ||
      account !== claims.resource.effectiveAccountId ||
      req.header('x-oxy-user-id') !== account
    ) {
      res.status(403).json({ error: 'first_party_capability_not_declared' });
      return;
    }
    writes.push({
      account,
      forwarded: [
        req.header('x-oxy-capability-ticket'),
        req.header('x-oxy-requester-token'),
        req.header('x-oxy-task-id'),
      ],
    });
    res.json({
      data: { file: { id: 'file-original-person', mime: 'image/png', status: 'active' } },
    });
  });
  // Mention's declared `oxy:privacy` read: the blocks of the account it acts for.
  api.get('/privacy/blocked', (req, res) => {
    if (!admitted(req)) {
      res.status(403).json({ error: 'verified_requester_required' });
      return;
    }
    res.json([{ blockedId: `blocked-by-${req.header('x-oxy-user-id')}` }]);
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
describe('Gemies operation → Mention HTTP → Oxy Files on Mention’s declared authority', () => {
  it('stores in the ticket’s account and never forwards the ticket, a session or a task', async () => {
    const result = await upload();
    expect(result.status).toBe(200);
    expect(result.body.fileId).toBe('file-original-person');
    expect(writes).toEqual([
      { account: 'original-person', forwarded: [undefined, undefined, undefined] },
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
  it('asks Safety for the ticket’s account, never with the ticket', () => {
    const context: RequestSafetyContext = {
      user: { id: 'original-person' },
      capability: { ticket, claims },
    };
    expect(safetyRequesterFor(context)).toEqual({ actingForAccountId: 'original-person' });
  });
});

describe('a blocked person stays hidden when Mention acts for an account', () => {
  const capability: RequestSafetyContext = {
    user: { id: 'original-person' },
    capability: { ticket, claims },
  };
  const service: RequestSafetyContext = {
    user: { id: 'org-account' },
    serviceApp: { authority: 'first_party' },
    serviceActingAs: {
      authority: 'first_party',
      userId: 'org-account',
      requesterId: 'original-person',
    },
  };
  it('on the capability-ticket path', async () => {
    expect(await getBlockedUserIds(createScopedOxyClient(capability))).toEqual([
      'blocked-by-original-person',
    ]);
  });
  it('on the service path, for the account the person operates', async () => {
    expect(await getBlockedUserIds(createScopedOxyClient(service))).toEqual([
      'blocked-by-org-account',
    ]);
    expect(safetyRequesterFor(service)).toEqual({ actingForAccountId: 'org-account' });
  });
  it('fails closed, never empty, when Oxy refuses the read', async () => {
    const undeclared: RequestSafetyContext = {
      ...service,
      serviceActingAs: { authority: 'first_party', userId: 'org-account', requesterId: 'other' },
    };
    await expect(getBlockedUserIds(createScopedOxyClient(undeclared))).rejects.toBeInstanceOf(
      OxyPrivacyAuthorizationError,
    );
  });
});
