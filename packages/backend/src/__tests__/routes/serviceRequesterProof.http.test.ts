import { mentionForOxyService } from '@oxy.so/mention-sdk/server';
import { createServicePublishingRouter } from '../../routes/servicePublishing';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxyServer } from '@oxy.so/core/server';
import { MENTION_SERVICE_APPLICATION_ID } from '@oxy.so/mention-contracts';
import { setRuntimeOxyClient, clearRuntimeOxyClient } from '../../runtime/oxyClient';
import intentMediaRoutes from '../../routes/intentMedia';

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
const audience = `oxy-service:${MENTION_SERVICE_APPLICATION_ID}` as const;
const context = 'central-verified-recipient-context';
const now = Math.floor(Date.now() / 1000);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = {
  type: 'service',
  authority: 'first_party',
  tier: 'internal',
  appId: 'move',
  appName: 'Move',
  credentialId: 'wl_move',
  ownerAccountId: 'move-operator',
  environment: 'production',
  iss: 'oxy-auth',
  aud: audience,
  iat: now,
  exp: now + 300,
};
const signed = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: 'fixture' })}.${encode(claims)}`;
const moveToken = `${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString('base64url')}`;
const externalSigned = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: 'fixture' })}.${encode({ ...claims, authority: 'external', credentialId: 'credential_move', scopes: ['social.posts.publish'] })}`;
const externalToken = `${externalSigned}.${sign(null, Buffer.from(externalSigned), keys.privateKey).toString('base64url')}`;
const platformToken = `e30.${encode({ exp: now + 300, authority: 'first_party' })}.fixture`;
const jwks = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    keys: [
      { ...keys.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid: 'fixture' },
    ],
  }),
)}`;
let authority: Server;
let receiver: Server;
let caller: OxyServer;
let oxy: OxyServer;
let receiverURL: string;
let revoked = false;
let downstreamRevoked = false;
const publications: string[] = [];
const receipts = new Set<string>();
const writes: Array<{
  account: string;
  proof: string;
  task: string | undefined;
  session: string | undefined;
}> = [];

beforeAll(async () => {
  const api = express();
  api.use(express.json());
  api.post('/auth/service-token/workload/challenge', (_req, res) => res.json({ nonce: 'fixture' }));
  api.post('/auth/service-token/workload', (req, res) => {
    expect(req.body.protocolVersion).toBe(2);
    res.json({ token: req.body.audience === audience ? moveToken : platformToken, expiresIn: 300 });
  });
  api.post('/auth/resources/introspect', (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${platformToken}`);
    res.json(
      req.body.token === moveToken && !revoked
        ? {
            active: true,
            authority: 'first_party',
            applicationId: 'move',
            credentialId: 'wl_move',
            accountId: 'move-operator',
            environment: 'production',
            audience,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
          }
        : { active: false },
    );
  });
  api.get('/internal/service-acting-as/verify', (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${platformToken}`);
    // The original coordinator task reaches Oxy, never Files under Mention's identity.
    const authorized =
      !revoked &&
      req.query.appId === 'move' &&
      ((req.query.userId === 'original-person' && req.query.taskId === 'original-move-task') ||
        (req.query.userId === 'second-person' && req.query.taskId === 'second-task'));
    res.json(
      authorized
        ? { authorized: true, authority: 'first_party', epoch: '1', requesterContext: context }
        : { authorized: false, scopes: [], epoch: '1' },
    );
  });
  api.post('/assets/service/user-media', express.raw({ type: '*/*' }), (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${platformToken}`);
    const proof = req.header('x-oxy-requester-context');
    const account = req.header('x-owner-user-id');
    if (downstreamRevoked || revoked || proof !== context || account !== 'original-person') {
      res.status(403).json({ error: 'original_authority_refused' });
      return;
    }
    writes.push({
      account,
      proof,
      task: req.header('x-oxy-task-id'),
      session: req.header('x-oxy-requester-token'),
    });
    res.json({
      data: { file: { id: 'original-person-file', mime: 'image/png', status: 'active' } },
    });
  });
  api.use((_req, res) => res.json({ data: [] }));
  authority = api.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => authority.once('listening', resolve));
  const baseURL = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
  const workloadCredentials = async () => ({
    AccessKeyId: 'ASIA_TEST',
    SecretAccessKey: 'fixture-only',
    Token: 'temporary-test',
  });
  oxy = new OxyServer({ baseURL, workloadCredentials });
  caller = new OxyServer({ baseURL, workloadCredentials });
  setRuntimeOxyClient(oxy);
  const app = express();
  app.use(express.json());
  app.use(oxy.middleware.auth({ serviceTokenJwksUrl: jwks, expectedAudience: audience }));
  app.use('/posts/intent-media', intentMediaRoutes);
  app.use(
    '/publishing/v1',
    createServicePublishingRouter(
      (req, res) => {
        const account = req.user!.id;
        publications.push(account);
        res.status(201).json({ success: true, post: { id: `post-${account}` } });
      },
      {
        async reserve(identity) {
          const key = `${identity.oxyUserId}:${identity.clientId}:${identity.idempotencyKey}`;
          if (receipts.has(key))
            return {
              kind: 'duplicate' as const,
              status: 'succeeded' as const,
              responseStatus: 201,
            };
          receipts.add(key);
          return { kind: 'reserved' as const, receiptId: key };
        },
        async finalize() {},
      },
    ),
  );
  receiver = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => receiver.once('listening', resolve));
  receiverURL = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
beforeEach(() => {
  revoked = false;
  downstreamRevoked = false;
  writes.length = 0;
  publications.length = 0;
  receipts.clear();
});
afterAll(async () => {
  clearRuntimeOxyClient();
  oxy.dispose();
  caller.dispose();
  for (const server of [receiver, authority]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function upload(accountId = 'original-person') {
  const transport = caller.createServiceClient({
    baseURL: receiverURL,
    audience,
    requester: { accountId, taskId: 'original-move-task' },
  });
  try {
    return await transport.fetch(`${receiverURL}/posts/intent-media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        base64: Buffer.from('PNG!').toString('base64'),
        mimeType: 'image/png',
        ownerUserId: 'move-operator',
      }),
    });
  } finally {
    transport.dispose();
  }
}
describe('Move shared SDK → Mention receiver → Oxy Files', () => {
  it('derives recipient authority and preserves the original account without copying the coordinator task', async () => {
    const response = await upload();
    expect(response.status).toBe(200);
    expect(writes).toEqual([
      { account: 'original-person', proof: context, task: undefined, session: undefined },
    ]);
  });
  it('does not turn another attributed account into authority', async () => {
    expect((await upload('move-operator')).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it('revalidates a revoked workload before deriving any downstream proof', async () => {
    revoked = true;
    expect((await upload()).status).toBe(401);
    expect(writes).toHaveLength(0);
  });
  it('honours revocation between receiver verification and downstream execution without a fallback', async () => {
    downstreamRevoked = true;
    expect((await upload()).status).toBe(502);
    expect(writes).toHaveLength(0);
  });
});

describe('Own publishing SDK → Mention shared auth → native publication adapter', () => {
  const key = `mcp:${'b'.repeat(64)}`;
  const input = {
    content: { text: 'scheduled' },
    visibility: 'public' as const,
    status: 'published' as const,
  };
  function publishing(accountId = 'original-person', taskId = 'original-move-task') {
    return mentionForOxyService(caller, { baseURL: receiverURL, requester: { accountId, taskId } });
  }
  it('reserves a stable effect before domain dispatch and refuses duplicate without another effect', async () => {
    const sdk = publishing();
    try {
      expect((await sdk.publish(input, key)).id).toBe('post-original-person');
      await expect(sdk.publish(input, key)).rejects.toMatchObject({
        status: 409,
        unknownOutcome: true,
      });
      expect(publications).toEqual(['original-person']);
    } finally {
      sdk.dispose();
    }
  });
  it('keeps the same idempotency key separate for two independently authorized accounts', async () => {
    const first = publishing(),
      second = publishing('second-person', 'second-task');
    try {
      await first.publish(input, key);
      await second.publish(input, key);
      expect(publications).toEqual(['original-person', 'second-person']);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
  it('refuses wrong-account and revoked original authority before reserving or publishing', async () => {
    const wrong = publishing('second-person'),
      valid = publishing();
    try {
      await expect(wrong.publish(input, key)).rejects.toMatchObject({ status: 403 });
      revoked = true;
      await expect(valid.publish(input, key)).rejects.toMatchObject({ status: 401 });
      expect(publications).toEqual([]);
      expect(receipts.size).toBe(0);
    } finally {
      wrong.dispose();
      valid.dispose();
    }
  });
  it('never turns an official application external credential and a user header into own publication authority', async () => {
    const response = await fetch(`${receiverURL}/publishing/v1/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${externalToken}`,
        'X-Oxy-User-Id': 'original-person',
        'X-Oxy-Task-Id': 'original-move-task',
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(input),
    });
    expect([401, 403]).toContain(response.status);
    expect(publications).toEqual([]);
    expect(receipts.size).toBe(0);
  });
});
