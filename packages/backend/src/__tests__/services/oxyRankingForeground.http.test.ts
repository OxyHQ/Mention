import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServer } from '@oxy.so/core/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForegroundOxyProfileClient } from '../../services/ForegroundOxyProfileClient';

const mocks = vi.hoisted(() => ({ serviceRequest: vi.fn() }));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ serviceRequest: mocks.serviceRequest }),
  getMentionOxyClientId: () => 'fixture_mention_application',
}));
import { OxyRankingClient } from '../../services/OxyRankingClient';

const servers: http.Server[] = [];
const CATALOG = { registrationId: 'fixture_oxy_profiles', version: '1.0.0', digest: 'a'.repeat(64) };
const REQUESTER = 'fixture_requester_bearer';
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.clearAllMocks();
});

async function endpoint(failure: 'approval' | 'ticket' | 'invoke' | 'subject' | 'cleanup' | undefined = undefined) {
  const observed: Array<{ path: string; method?: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let approval: Record<string, unknown> = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      observed.push({ path: req.url ?? '', method: req.method, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/auth/service-token') {
        res.end(JSON.stringify({ token: 'fixture_presenter_service_token', expiresIn: 3600 }));
      } else if (req.url === '/capabilities/foreground-execution-authorizations') {
        approval = body;
        res.statusCode = failure === 'approval' ? 403 : 201;
        res.end(JSON.stringify({ authorization: { id: 'fixture_approval' } }));
      } else if (req.url === '/capabilities/tickets') {
        res.end(JSON.stringify({ decision: { allowed: failure !== 'ticket' }, ticket: 'fixture_signed_ticket', claims: {
          actor: { type: 'requester', accountId: 'fixture_principal' }, autonomy: 'read_only',
          resource: { appId: 'oxy', resourceType: 'account', resourceId: failure === 'subject' ? 'other' : 'fixture_subject', effectiveAccountId: failure === 'subject' ? 'other' : 'fixture_subject' },
          catalog: CATALOG, tool: 'recommendProfiles', runId: approval.runId, stepId: approval.stepId,
        } }));
      } else if (req.url === '/_oxy/capabilities/profiles/recommendations') {
        res.statusCode = failure === 'invoke' ? 403 : 200;
        res.end(JSON.stringify({ recommendations: [{ id: 'fixture_ranked', name: { displayName: 'Fixture' }, score: 42, matchedSignals: ['private_mention_profile'] }] }));
      } else if (req.method === 'DELETE' && req.url === '/capabilities/execution-authorizations/fixture_approval') {
        res.statusCode = failure === 'cleanup' ? 503 : 204;
        res.end();
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverClient = new OxyServer({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, serviceAuth: { apiKey: 'fixture_presenter', apiSecret: 'fixture_secret' } });
  return { client: new ForegroundOxyProfileClient(serverClient, REQUESTER, 'fixture_subject', CATALOG), observed };
}

// Installed candidate SDK and real loopback HTTP; authority responses are
// synthetic transport fixtures. Real SQL/signatures are in Oxy's separate suite.
describe('foreground ranking through common agency and installed SDK transport', () => {
  it('preserves private clientId, signed subject, request-body requester and requester-only cleanup', async () => {
    const { client, observed } = await endpoint();
    const page = await new OxyRankingClient().rank({ viewerId: 'fixture_subject', foregroundClient: client, limit: 10 });
    expect(page.profiles[0].score).toBe(42);
    expect(page.profiles[0].matchedSignals).toEqual(['private_mention_profile']);
    const approval = observed.find((record) => record.path === '/capabilities/foreground-execution-authorizations');
    expect(approval?.headers.authorization).toBe('Bearer fixture_presenter_service_token');
    expect(approval?.body.subjectToken).toBe(REQUESTER);
    expect(approval?.body.expectedCatalog).toEqual(CATALOG);
    expect(approval?.body).not.toHaveProperty('requesterAccountId');
    const invoke = observed.find((record) => record.path === '/_oxy/capabilities/profiles/recommendations');
    expect(invoke?.headers.authorization).toBe('Capability fixture_signed_ticket');
    expect(invoke?.body).toEqual({ clientId: 'fixture_mention_application', limit: 10 });
    const cleanup = observed.at(-1);
    expect(cleanup?.method).toBe('DELETE');
    expect(cleanup?.headers.authorization).toBe(`Bearer ${REQUESTER}`);
    expect(cleanup?.body).toEqual({});
    expect(observed.every((record) => record.headers['x-oxy-user-id'] === undefined)).toBe(true);
    expect(observed.filter((record) => JSON.stringify(record.body).includes(REQUESTER))).toHaveLength(1);
    expect(mocks.serviceRequest).not.toHaveBeenCalled();
  });

  it('issues a fresh bounded approval for each personalized read', async () => {
    const { client, observed } = await endpoint();
    const ranking = new OxyRankingClient();
    await ranking.rank({ viewerId: 'fixture_subject', foregroundClient: client, limit: 10 });
    await ranking.rank({ viewerId: 'fixture_subject', foregroundClient: client, limit: 10 });
    const approvals = observed.filter((record) => record.path === '/capabilities/foreground-execution-authorizations');
    expect(approvals).toHaveLength(2);
    expect(approvals[0].body.runId).not.toBe(approvals[1].body.runId);
    expect(observed.filter((record) => record.method === 'DELETE')).toHaveLength(2);
  });

  it('rejects a missing foreground proof before using app-only identity', async () => {
    await expect(new OxyRankingClient().rank({ viewerId: 'fixture_subject', limit: 10 })).rejects.toThrow('verified foreground bearer');
    expect(mocks.serviceRequest).not.toHaveBeenCalled();
  });

  it.each(['approval', 'ticket', 'invoke', 'subject', 'cleanup'] as const)('refuses %s without legacy or app-only fallback', async (failure) => {
    const { client, observed } = await endpoint(failure);
    await expect(new OxyRankingClient().rank({ viewerId: 'fixture_subject', foregroundClient: client, limit: 10 })).rejects.toThrow(/^FOREGROUND_/);
    expect(mocks.serviceRequest).not.toHaveBeenCalled();
    expect(observed.some((record) => record.path === '/profiles/recommendations')).toBe(false);
    if (failure !== 'approval') expect(observed.at(-1)?.method).toBe('DELETE');
    if (failure === 'ticket' || failure === 'subject') expect(observed.some((record) => record.path.startsWith('/_oxy/'))).toBe(false);
  });
});
