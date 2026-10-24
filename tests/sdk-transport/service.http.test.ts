import { afterAll, beforeAll, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { OxyServer, type OxyAuthRequest } from '@oxy.so/core/server';
import {
  MENTION_SERVICE_APPLICATION_ID,
  mentionForOxyService,
} from '../../packages/sdk/dist/server.js';

const keys = generateKeyPairSync('ed25519');
const audience = `oxy-service:${MENTION_SERVICE_APPLICATION_ID}` as const;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const claims = {
  type: 'service',
  authority: 'first_party',
  tier: 'internal',
  appId: 'move',
  appName: 'Move',
  credentialId: 'wl_move',
  ownerAccountId: 'operator',
  environment: 'production',
  iss: 'oxy-auth',
  aud: audience,
  iat: now,
  exp: now + 300,
};
function token(aud: string): string {
  const body = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: 'fixture' })}.${encode({ ...claims, aud })}`;
  return `${body}.${sign(null, Buffer.from(body), keys.privateKey).toString('base64url')}`;
}
const recipientToken = token(audience);
const platformToken = token('oxy-api');
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
let verifier: OxyServer;
let receiverURL: string;
let revoked = false;
const versions: unknown[] = [];
const effectiveAccounts: string[] = [];
async function listen(app: express.Express): Promise<Server> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return server;
}
const url = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
beforeAll(async () => {
  const api = express();
  api.use(express.json());
  api.post('/auth/service-token/workload/challenge', (_req, res) => res.json({ nonce: 'fixture' }));
  api.post('/auth/service-token/workload', (req, res) => {
    versions.push(req.body.protocolVersion);
    res.json({
      token: req.body.audience === audience ? recipientToken : platformToken,
      expiresIn: 300,
    });
  });
  api.post('/auth/resources/introspect', (req, res) =>
    res.json(
      !revoked && req.body.token === recipientToken
        ? {
            active: true,
            authority: 'first_party',
            applicationId: 'move',
            credentialId: 'wl_move',
            accountId: 'operator',
            environment: 'production',
            audience,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
          }
        : { active: false },
    ),
  );
  api.get('/internal/service-acting-as/verify', (req, res) => {
    const authorized =
      !revoked &&
      req.query.appId === 'move' &&
      ['person-a', 'person-b'].includes(String(req.query.userId)) &&
      req.query.taskId === `task:${String(req.query.userId)}`;
    res.json(
      authorized
        ? {
            authorized: true,
            authority: 'first_party',
            epoch: '1',
            requesterContext: 'verified-context',
          }
        : { authorized: false, scopes: [], epoch: '1' },
    );
  });
  authority = await listen(api);
  const workloadCredentials = async () => ({
    AccessKeyId: 'ASIA_TEST',
    SecretAccessKey: 'fixture',
    Token: 'temporary',
  });
  caller = new OxyServer({ baseURL: url(authority), workloadCredentials });
  verifier = new OxyServer({ baseURL: url(authority), workloadCredentials });
  const app = express();
  app.use(verifier.middleware.auth({ expectedAudience: audience, serviceTokenJwksUrl: jwks }));
  app.get('/imports/v1/lookup', (req: OxyAuthRequest, res) => {
    const account = req.user?.id;
    if (!account) throw new Error('Missing verified requester');
    effectiveAccounts.push(account);
    res.json({ imported: { sameSource: account }, federated: {} });
  });
  receiver = await listen(app);
  receiverURL = url(receiver);
});
afterAll(async () => {
  caller?.dispose();
  verifier?.dispose();
  await Promise.all(
    [authority, receiver]
      .filter(Boolean)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
it('composes published core 7 and the shared receiver with original accounts and live revocation', async () => {
  const clients = ['person-a', 'person-b'].map((accountId) =>
    mentionForOxyService(caller, {
      baseURL: receiverURL,
      requester: { accountId, taskId: `task:${accountId}` },
    }),
  );
  const wrong = mentionForOxyService(caller, {
    baseURL: receiverURL,
    requester: { accountId: 'person-b', taskId: 'task:person-a' },
  });
  try {
    for (const [index, client] of clients.entries()) {
      const result = await client.lookupImports({
        platform: 'mastodon',
        sourceIds: ['sameSource'],
      });
      expect(result.imported.sameSource).toBe(index === 0 ? 'person-a' : 'person-b');
    }
    await expect(wrong.lookupImports({ platform: 'mastodon' })).rejects.toMatchObject({
      status: 403,
    });
    revoked = true;
    await expect(clients[0].lookupImports({ platform: 'mastodon' })).rejects.toMatchObject({
      status: 401,
    });
    expect(effectiveAccounts).toEqual(['person-a', 'person-b']);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => version === 2)).toBe(true);
  } finally {
    for (const client of [...clients, wrong]) client.dispose();
  }
});
