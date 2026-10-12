/**
 * The property behind the 2026-09 rollover incident: an MCP client must work
 * no matter which task behind the load balancer answers each request.
 *
 * Two independent `server-http.ts` processes stand in for two ECS tasks. They
 * share nothing but a fake Oxy (introspection) and a fake Mention API, exactly
 * as two tasks share only api.oxy.so and api.mention.earth. Before the fix a
 * client that initialized on task A was answered `404 Session not found` by
 * task B.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  MENTION_CAPABILITY_AUDIENCE,
  MENTION_MCP_CAPABILITIES,
} from '@mention/shared-types/mcpCapabilities';
import { spawnMcpServer, type SpawnedMcpServer } from './support/spawn-server.js';

const PUBLIC_URL = 'http://127.0.0.1';

/** A compact JWS whose header says EdDSA, so the server asks Oxy about it. */
function centralToken(name: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ name })).toString('base64url'),
    'signature',
  ].join('.');
}

const TOKEN = centralToken('account-1');
const OTHER_CLIENT_TOKEN = centralToken('account-1-other-client');

interface ApiCall {
  method: string;
  path: string;
  idempotencyKey: string | null;
  authorization: string | null;
}

let oxy: ReturnType<typeof Bun.serve>;
let api: ReturnType<typeof Bun.serve>;
let taskA: SpawnedMcpServer;
let taskB: SpawnedMcpServer;
const apiCalls: ApiCall[] = [];
let introspections = 0;

beforeAll(async () => {
  oxy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/auth/service-token') {
        return Response.json({ token: 'service-token', expiresIn: 3600 });
      }
      if (url.pathname === '/auth/mcp/oauth/introspect') {
        introspections++;
        if (request.headers.get('authorization') !== 'Bearer service-token') {
          return new Response(null, { status: 401 });
        }
        const { token } = (await request.json()) as { token: string };
        const clientId =
          token === TOKEN
            ? 'claude-connector'
            : token === OTHER_CLIENT_TOKEN
              ? 'herald'
              : undefined;
        if (!clientId) return Response.json({ active: false });
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          active: true,
          iss: `http://127.0.0.1:${oxy.port}`,
          sub: 'user-1',
          aud: MENTION_CAPABILITY_AUDIENCE,
          resource: PUBLIC_URL,
          client_id: clientId,
          scope: MENTION_MCP_CAPABILITIES.join(' '),
          jti: `jti-${clientId}`,
          iat: now,
          exp: now + 3600,
          account_id: 'account-1',
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      apiCalls.push({
        method: request.method,
        path: url.pathname,
        idempotencyKey: request.headers.get('idempotency-key'),
        authorization: request.headers.get('authorization'),
      });
      return Response.json({ success: true });
    },
  });

  const env = {
    OXY_API_URL: `http://127.0.0.1:${oxy.port}`,
    MENTION_API_URL: `http://127.0.0.1:${api.port}`,
    MENTION_MCP_PUBLIC_URL: PUBLIC_URL,
  };
  [taskA, taskB] = await Promise.all([spawnMcpServer(env), spawnMcpServer(env)]);
}, 30_000);

afterAll(async () => {
  await Promise.all([taskA?.stop(), taskB?.stop()]);
  oxy?.stop(true);
  api?.stop(true);
});

const ACCEPT = 'application/json, text/event-stream';

async function rpc(
  baseUrl: string,
  message: Record<string, unknown>,
  options: { sessionId?: string; token?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token ?? TOKEN}`,
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      ...(options.sessionId
        ? { 'Mcp-Session-Id': options.sessionId, 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });
}

/** The single JSON-RPC message of a JSON or SSE response. */
async function rpcResult(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    return JSON.parse(data.at(-1) ?? 'null') as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function initialize(baseUrl: string, token = TOKEN): Promise<string> {
  const response = await rpc(
    baseUrl,
    {
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'rollover-test', version: '1.0.0' },
      },
    },
    { token },
  );
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  expect((await rpcResult(response)).result).toMatchObject({
    serverInfo: { name: 'mention' },
  });
  return sessionId!;
}

function likeCall(id: number, postId: string): Record<string, unknown> {
  return {
    id,
    method: 'tools/call',
    params: { name: 'like-post', arguments: { id: postId } },
  };
}

/**
 * A tool call, read to its END. Over SSE the headers arrive before the tool has
 * run, so the API call it makes is only certain once the body is consumed.
 */
async function callTool(
  baseUrl: string,
  message: Record<string, unknown>,
  options: { sessionId?: string; token?: string } = {},
): Promise<Record<string, unknown>> {
  return rpcResult(await rpc(baseUrl, message, options));
}

function likeCallsFor(postId: string): ApiCall[] {
  return apiCalls.filter((call) => call.method === 'POST' && call.path === `/posts/${postId}/like`);
}

describe('Stateless Streamable HTTP across independent tasks', () => {
  test('a session initialized on one task calls tools on another', async () => {
    const sessionId = await initialize(taskA.baseUrl);

    const initialized = await rpc(
      taskB.baseUrl,
      { method: 'notifications/initialized' },
      { sessionId },
    );
    expect(initialized.status).toBe(202);

    const listed = await rpc(taskB.baseUrl, { id: 1, method: 'tools/list' }, { sessionId });
    expect(listed.status).toBe(200);
    const tools = (await rpcResult(listed)).result as { tools: { name: string }[] };
    expect(tools.tools.map((tool) => tool.name)).toContain('like-post');

    const called = await rpc(taskB.baseUrl, likeCall(2, 'post-across-tasks'), { sessionId });
    expect(called.status).toBe(200);
    expect((await rpcResult(called)).result).toMatchObject({
      content: [{ type: 'text', text: 'Post post-across-tasks liked.' }],
    });

    const [write] = likeCallsFor('post-across-tasks');
    expect(write?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(write?.idempotencyKey).toMatch(/^mcp:[0-9a-f]{64}$/);
  });

  test('the official SDK client works while an ALB alternates every request between tasks', async () => {
    let turn = 0;
    const statuses: number[] = [];
    const roundRobin: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const target = turn++ % 2 === 0 ? taskA : taskB;
        const url = new URL(input instanceof Request ? input.url : String(input));
        const response = await fetch(`${target.baseUrl}${url.pathname}${url.search}`, init);
        statuses.push(response.status);
        return response;
      },
      { preconnect: fetch.preconnect },
    );

    const client = new Client({ name: 'alb-round-robin', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${taskA.baseUrl}/mcp`), {
      fetch: roundRobin,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(90);
    const result = await client.callTool({ name: 'like-post', arguments: { id: 'post-sdk' } });
    expect(result.content).toEqual([{ type: 'text', text: 'Post post-sdk liked.' }]);
    const again = await client.listTools();
    expect(again.tools.length).toBe(tools.length);

    await transport.terminateSession();
    await client.close();

    expect(turn).toBeGreaterThanOrEqual(4);
    expect(statuses).not.toContain(404);
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
  });

  test('a session id from before the deploy keeps working on any task, never 404', async () => {
    // Issued by a task that no longer exists: no task has ever seen it.
    const staleSessionId = '5b0c7f0e-3c1f-4b8e-9d7e-previous-task';
    for (const task of [taskA, taskB]) {
      const response = await rpc(
        task.baseUrl,
        { id: 7, method: 'tools/list' },
        {
          sessionId: staleSessionId,
        },
      );
      expect(response.status).toBe(200);
      expect((await rpcResult(response)).result).toHaveProperty('tools');
    }
  });

  test('a retried write gets the same idempotency key on whichever task serves it', async () => {
    const sessionId = await initialize(taskA.baseUrl);
    await callTool(taskA.baseUrl, likeCall(3, 'post-retried'), { sessionId });
    await callTool(taskB.baseUrl, likeCall(3, 'post-retried'), { sessionId });

    const writes = likeCallsFor('post-retried');
    expect(writes).toHaveLength(2);
    expect(writes[0]!.idempotencyKey).toBeTruthy();
    expect(writes[1]!.idempotencyKey).toBe(writes[0]!.idempotencyKey);
  });

  test('request ids reused by a new connection or another client never collide', async () => {
    const first = await initialize(taskA.baseUrl);
    const second = await initialize(taskB.baseUrl);
    const otherClient = await initialize(taskA.baseUrl, OTHER_CLIENT_TOKEN);
    expect(new Set([first, second, otherClient]).size).toBe(3);

    await callTool(taskB.baseUrl, likeCall(2, 'post-reused-id'), { sessionId: first });
    await callTool(taskA.baseUrl, likeCall(2, 'post-reused-id'), { sessionId: second });
    await callTool(taskB.baseUrl, likeCall(2, 'post-reused-id'), {
      sessionId: first,
      token: OTHER_CLIENT_TOKEN,
    });

    const keys = likeCallsFor('post-reused-id').map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  test('still authenticates every request on every task', async () => {
    const sessionId = await initialize(taskA.baseUrl);
    const before = introspections;
    for (const task of [taskA, taskB]) {
      const missing = await fetch(`${task.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: ACCEPT,
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toContain('resource_metadata=');

      const revoked = await rpc(
        task.baseUrl,
        { id: 1, method: 'tools/list' },
        {
          sessionId,
          token: centralToken('revoked'),
        },
      );
      expect(revoked.status).toBe(401);
    }
    expect(introspections).toBeGreaterThan(before);
  });

  test('requires a session id after initialize, and rejects a malformed one', async () => {
    const missing = await rpc(taskB.baseUrl, { id: 1, method: 'tools/list' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain(
      'Mcp-Session-Id header is required',
    );

    const malformed = await rpc(
      taskB.baseUrl,
      { id: 1, method: 'tools/list' },
      {
        sessionId: 'has spaces',
      },
    );
    expect(malformed.status).toBe(400);
  });

  test('answers GET and DELETE with 405, not 404, after authenticating', async () => {
    const sessionId = await initialize(taskA.baseUrl);
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${taskB.baseUrl}/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'text/event-stream',
          'Mcp-Session-Id': sessionId,
        },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST, OPTIONS');

      const anonymous = await fetch(`${taskB.baseUrl}/mcp`, { method });
      expect(anonymous.status).toBe(401);
    }
  });
});
