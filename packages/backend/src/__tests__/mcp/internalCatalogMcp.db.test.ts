/** Signed common MCP → canonical Mention handler → real SQL domain/receipts.
 * Oxy's remote mutable authority is a loopback fixture, not a live grant.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalCapabilityJson, type AppCapabilityCatalog, type CapabilityCatalogBinding, type CapabilityTicketClaims } from '@oxy.so/contracts';
import { createLiveCapabilityTicketVerifier, issueCapabilityTicket, verifyCapabilityTicket } from '@oxy.so/core/server';
import { createInternalCatalogMcpClient } from '@oxy.so/mcp';
import { connectPostgres, closePostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { bookmarks } from '../../db/schema/engagement';
import { mcpEffectReceipts } from '../../db/schema/mcp';
import { savePost } from '../../controllers/posts/bookmarks';
import { createOptionalMentionCapabilityAuth } from '../../capabilities/capabilityAuth.middleware';
import { createMentionCapabilityEffectIdempotency } from '../../capabilities/capabilityEffectIdempotency.middleware';
import type { McpHttpConfig } from '../../../../mcp/lib/config';

const keys = generateKeyPairSync('ed25519');
const oldEnvironment = new Map(['MENTION_API_URL', 'MENTION_MCP_PUBLIC_URL'].map(key => [key, process.env[key]]));
const servers: Server[] = [];
const account = 'fixture-i05-assigned';
let db: Database;
let issuer: string;
let backend: string;
let origin: string;
let catalog: AppCapabilityCatalog;
let binding: CapabilityCatalogBinding;
let receiver: ReturnType<typeof import('../../../../mcp/lib/internal-capability-mcp').createMentionInternalMcp>;
let postId: string;
let active = true;
let revokeAtBackend = false;
let auditUnavailable = false;
let auditCount = 0;
let revokeDuringAudit = false;
let backendRequests = 0;
let receivedAuditKeys: unknown[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function ticket(tool = 'save-post', overrides: Partial<CapabilityTicketClaims> = {}) {
  const policy = catalog.tools.find(entry => entry.name === tool);
  if (!policy) throw new Error('Fixture tool missing');
  return issueCapabilityTicket({
    aud: catalog.audience, sub: 'fixture-agent',
    requesterAccountId: 'fixture-requester', ownerAccountId: 'fixture-requester',
    actor: { type: 'agent', accountId: 'fixture-agent' },
    coordinator: { applicationId: 'alia', credentialId: 'fixture-alia-credential' },
    executionAuthorization: { kind: 'direct_request', id: 'fixture-authorization' },
    runId: 'fixture-run', stepId: tool,
    resource: { appId: catalog.appId, effectiveAccountId: account, resourceType: 'mention_account', resourceId: account },
    tool, capabilities: policy.requiredCapabilities, limits: [], autonomy: 'execute_on_request', catalog: binding,
    ...overrides,
  }, { issuer, keyId: 'fixture-key', privateKey: keys.privateKey });
}

async function rpc(token: string, tool: string, input: Record<string, unknown>, key?: string, scheme = 'Capability') {
  const response = await fetch(`${origin}/_oxy/mcp`, {
    method: 'POST', headers: { authorization: `${scheme} ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } }),
  });
  const result = await response.json();
  return { response, result };
}

beforeAll(async () => {
  db = await connectPostgres();
  const oxy = express();
  oxy.use(rateLimit({ windowMs: 60_000, limit: 128, keyGenerator: () => 'fixture-i05-authority', validate: false }));
  oxy.use(express.json());
  oxy.post('/auth/service-token', (_request, response) => response.json({ token: 'fixture-service-token', expiresIn: 3600 }));
  oxy.get('/capabilities/.well-known/jwks.json', (_request, response) => response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'EdDSA', use: 'sig' }] }));
  oxy.post('/capabilities/tickets/introspect', (request, response) => {
    expect(request.header('authorization')).toBe('Bearer fixture-service-token');
    const claims = verifyCapabilityTicket(request.body.ticket, { issuer, audience: catalog.audience, resolvePublicKey: () => keys.publicKey });
    response.json({ active, claims, decision: { allowed: active, reason: active ? 'fixture_allowed' : 'fixture_revoked' } });
  });
  oxy.post('/capabilities/audit', (request, response) => {
    auditCount += 1; receivedAuditKeys.push(request.body.idempotencyKey);
    if (revokeDuringAudit) active = false;
    response.status(auditUnavailable ? 503 : 200).json({ ok: !auditUnavailable });
  });
  issuer = await listen(createServer(oxy));
  const domain = express();
  domain.use(rateLimit({ windowMs: 60_000, limit: 128, keyGenerator: () => 'fixture-i05-domain', validate: false }));
  domain.use(express.json());
  const verify = createLiveCapabilityTicketVerifier({ issuer, audience: 'mention-api', resolvePublicKey: () => keys.publicKey,
    introspect: async token => {
      const response = await fetch(`${issuer}/capabilities/tickets/introspect`, { method: 'POST',
        headers: { authorization: 'Bearer fixture-service-token', 'content-type': 'application/json' }, body: JSON.stringify({ ticket: token }) });
      return response.json();
    } });
  domain.use((request, _response, next) => { backendRequests += 1; if (revokeAtBackend) active = false; next(); });
  domain.use(createOptionalMentionCapabilityAuth({ verify, introspect: async () => active }));
  domain.use(createMentionCapabilityEffectIdempotency());
  domain.post('/posts/:id/save', savePost);
  domain.get('/feed/item/:id', async (request, response) => {
    const [post] = await db.select().from(posts).where(eq(posts.id, request.params.id));
    if (!post) { response.status(404).json({ message: 'Post not found' }); return; }
    response.json({ id: post.id, oxyUserId: post.oxyUserId, content: { text: 'fixture SQL read' } });
  });
  backend = await listen(createServer(domain));
  const internalServer = createServer((request, response) => {
    if (request.url !== '/_oxy/mcp' || !receiver) { response.writeHead(404).end(); return; }
    void receiver.handleMcp(request, response);
  });
  origin = await listen(internalServer);
  process.env.MENTION_API_URL = backend;
  process.env.MENTION_MCP_PUBLIC_URL = origin;
  const definitions = await import('../../../../mcp/lib/mention-catalog');
  catalog = definitions.MENTION_CAPABILITY_CATALOG;
  binding = { registrationId: 'fixture-mention-registration', version: catalog.version,
    digest: createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex') };
  const { createMentionInternalMcp } = await import('../../../../mcp/lib/internal-capability-mcp');
  const config: McpHttpConfig = { internalCatalogBinding: binding, port: 0, maxRequestBodyBytes: 4096, maxSessions: 1,
    publicUrl: origin, oxyApiUrl: issuer, oxyServiceApiKey: 'fixture-key', oxyServiceApiSecret: 'fixture-secret',
    legacyOauthIssuer: issuer, jwtSecret: '', allowedOrigins: new Set() };
  receiver = createMentionInternalMcp(config);
});

beforeEach(async () => {
  active = true; revokeAtBackend = false; auditUnavailable = false; revokeDuringAudit = false; auditCount = 0; backendRequests = 0; receivedAuditKeys = [];
  await db.delete(mcpEffectReceipts).where(eq(mcpEffectReceipts.oxyUserId, account));
  await db.delete(bookmarks).where(eq(bookmarks.userId, account));
  if (postId) await db.delete(posts).where(eq(posts.id, postId));
  const [post] = await db.insert(posts).values({ oxyUserId: 'fixture-post-owner' }).returning({ id: posts.id });
  if (!post) throw new Error('Fixture post absent');
  postId = post.id;
});

afterAll(async () => {
  for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (db) {
    await db.delete(mcpEffectReceipts).where(eq(mcpEffectReceipts.oxyUserId, account));
    await db.delete(bookmarks).where(eq(bookmarks.userId, account));
    if (postId) await db.delete(posts).where(eq(posts.id, postId));
    await closePostgres();
  }
  for (const [key, value] of oldEnvironment) {
    if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
  }
});

describe('Mention internal common MCP with signed transport and SQL effects', () => {
  it('executes the canonical save handler and rejects replay/conflict before another effect', async () => {
    const token = ticket();
    const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
    const result = await client.callTool(token, 'save-post', { id: postId }, { idempotencyKey: 'fixture-operation-1' });
    expect(result.isError).not.toBe(true);
    expect(await db.select().from(bookmarks).where(eq(bookmarks.userId, account))).toHaveLength(1);
    const duplicate = await client.callTool(token, 'save-post', { id: postId }, { idempotencyKey: 'fixture-operation-1' });
    expect(duplicate.isError).toBe(true);
    expect(JSON.stringify(duplicate)).toContain('capability_effect_already_reserved');
    const conflict = await client.callTool(token, 'save-post', { id: 'different-post' }, { idempotencyKey: 'fixture-operation-1' });
    expect(JSON.stringify(conflict)).toContain('capability_idempotency_conflict');
    const another = await client.callTool(token, 'save-post', { id: postId }, { idempotencyKey: 'fixture-operation-2' });
    expect(another.isError).not.toBe(true);
    expect(await db.select().from(mcpEffectReceipts).where(eq(mcpEffectReceipts.oxyUserId, account))).toHaveLength(2);
    expect(await db.select().from(bookmarks).where(eq(bookmarks.userId, account))).toHaveLength(1);
    expect(receivedAuditKeys).toEqual(['fixture-operation-1', 'fixture-operation-1', 'fixture-operation-1', 'fixture-operation-2']);
  });

  it('shares the domain handler with direct Capability HTTP and preserves its refusal', async () => {
    const token = ticket();
    const response = await fetch(`${backend}/posts/${postId}/save`, { method: 'POST', headers: {
      authorization: `Capability ${token}`, 'X-Oxy-Capability-Tool': 'save-post', 'Idempotency-Key': 'fixture-http-key', 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(200);
    expect((await response.json()).savesCount).toBe(1);
    const missing = await rpc(token, 'save-post', { id: 'missing-post' }, 'fixture-missing');
    expect(missing.result.result.isError).toBe(true);
    expect(JSON.stringify(missing.result)).toContain('Post not found');
  });

  it('requires a stable operation key before any domain request', async () => {
    const result = await rpc(ticket(), 'save-post', { id: postId });
    expect(result.result.result.isError).toBe(true);
    expect(backendRequests).toBe(0);
    expect(auditCount).toBe(0);
  });

  it('does not accept ordinary Bearer, a forged signature, another catalogue or an account mismatch', async () => {
    expect((await rpc(ticket(), 'save-post', { id: postId }, 'fixture-key', 'Bearer')).response.status).toBe(401);
    const valid = ticket();
    expect((await rpc(`${valid.slice(0, -10)}AAAAAAAAAA`, 'save-post', { id: postId }, 'fixture-key')).response.status).toBe(403);
    expect((await rpc(ticket('save-post', { catalog: { ...binding, digest: 'b'.repeat(64) } }), 'save-post', { id: postId }, 'fixture-key')).response.status).toBe(403);
    const mismatch = await rpc(ticket('save-post', { resource: { appId: catalog.appId, effectiveAccountId: account, resourceType: 'mention_account', resourceId: 'other-account' } }), 'save-post', { id: postId }, 'fixture-key');
    expect(mismatch.result.result.isError).toBe(true);
    expect(backendRequests).toBe(0);
  });

  it('cannot call a different tool with a valid signed ticket', async () => {
    const result = await rpc(ticket(), 'like-post', { id: postId }, 'fixture-key');
    expect(Boolean(result.result.error || result.result.result?.isError)).toBe(true);
    expect(backendRequests).toBe(0);
  });

  it('rechecks withdrawal in the backend after transport acceptance', async () => {
    revokeAtBackend = true;
    const result = await rpc(ticket(), 'save-post', { id: postId }, 'fixture-key');
    expect(result.result.result.isError).toBe(true);
    expect(await db.select().from(bookmarks).where(eq(bookmarks.userId, account))).toHaveLength(0);
    expect(await db.select().from(mcpEffectReceipts).where(eq(mcpEffectReceipts.oxyUserId, account))).toHaveLength(0);
  });

  it('does not release a read after authority is withdrawn during the final audit await', async () => {
    revokeDuringAudit = true;
    const result = await rpc(ticket('get-post'), 'get-post', { id: postId });
    expect(result.result.result.isError).toBe(true);
    expect(JSON.stringify(result.result)).not.toContain('fixture SQL read');
    expect(auditCount).toBe(1);
    expect(backendRequests).toBe(1);
  });

  it('keeps a committed write successful and replay-safe when audit delivery fails', async () => {
    auditUnavailable = true;
    const result = await rpc(ticket(), 'save-post', { id: postId }, 'fixture-key');
    expect(result.result.result.isError).not.toBe(true);
    expect(await db.select().from(bookmarks).where(eq(bookmarks.userId, account))).toHaveLength(1);
    expect(auditCount).toBe(1);
  });
});
