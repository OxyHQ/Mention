import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityTicketClaims } from '@oxyhq/contracts';
import {
  createOptionalMentionCapabilityAuth,
  type MentionCapabilityAuthDependencies,
  type RequestWithMentionCapability,
} from '../../capabilities/capabilityAuth.middleware';
import { mentionCapabilityRateLimiter } from '../../capabilities/capabilityRateLimiter';

function claims(tool: string, capability: string): CapabilityTicketClaims {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: 'https://api.oxy.so',
    aud: 'mention-api',
    sub: 'agent-account',
    jti: `ticket-${tool}`,
    iat: now,
    exp: now + 60,
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
    tool,
    capabilities: [capability],
    limits: [],
    autonomy: 'execute_on_request',
  };
}

function appFor(
  ticketClaims: CapabilityTicketClaims,
  introspect = vi.fn(async () => true),
) {
  const dependencies: MentionCapabilityAuthDependencies = {
    verify: vi.fn(async () => ticketClaims),
    introspect,
  };
  const app = express();
  app.use(express.json());
  app.use(mentionCapabilityRateLimiter);
  app.use(createOptionalMentionCapabilityAuth(dependencies));
  app.all('*path', (req, res) => {
    const scoped = req as RequestWithMentionCapability;
    res.json({
      effectiveAccountId: scoped.user?.id,
      actor: scoped.capability?.claims.actor,
      accessToken: scoped.accessToken ?? null,
    });
  });
  return { app, dependencies };
}

describe('Mention capability authentication', () => {
  it('binds publication to the assigned account while preserving the agent actor', async () => {
    const { app, dependencies } = appFor(claims('create-post', 'social.posts.publish'));
    const response = await request(app)
      .post('/posts')
      .set('Authorization', 'Capability signed-ticket')
      .set('X-Oxy-Capability-Tool', 'create-post')
      .send({ content: { text: 'hello' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      effectiveAccountId: 'assigned-account',
      actor: { type: 'agent', accountId: 'agent-account' },
      accessToken: null,
    });
    expect(dependencies.introspect).toHaveBeenCalledOnce();
  });

  it('authorizes social reads and account-scoped content removal through exact tools', async () => {
    const read = await request(appFor(claims('get-post', 'social.posts.read')).app)
      .get('/feed/item/post-1')
      .set('Authorization', 'Capability read-ticket')
      .set('X-Oxy-Capability-Tool', 'get-post');
    expect(read.status).toBe(200);
    expect(read.body.effectiveAccountId).toBe('assigned-account');

    const removal = await request(appFor(claims('delete-post', 'social.posts.delete')).app)
      .delete('/posts/post-1')
      .set('Authorization', 'Capability delete-ticket')
      .set('X-Oxy-Capability-Tool', 'delete-post');
    expect(removal.status).toBe(200);
    expect(removal.body.actor).toEqual({ type: 'agent', accountId: 'agent-account' });
  });

  it('enforces numeric query limits after HTTP serialization', async () => {
    const bounded = claims('get-feed', 'social.read');
    bounded.limits = [{ tool: 'get-feed', key: 'limit', value: 20 }];

    const allowed = await request(appFor(bounded).app)
      .get('/feed/mtn')
      .query({ limit: 20 })
      .set('Authorization', 'Capability bounded-read-ticket')
      .set('X-Oxy-Capability-Tool', 'get-feed');
    expect(allowed.status).toBe(200);

    const denied = await request(appFor(bounded).app)
      .get('/feed/mtn')
      .query({ limit: 21 })
      .set('Authorization', 'Capability bounded-read-ticket')
      .set('X-Oxy-Capability-Tool', 'get-feed');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('capability_scope_mismatch');
  });

  it('rejects revocation between planning and domain execution', async () => {
    const { app } = appFor(
      claims('create-post', 'social.posts.publish'),
      vi.fn(async () => false),
    );
    const response = await request(app)
      .post('/posts')
      .set('Authorization', 'Capability revoked-ticket')
      .set('X-Oxy-Capability-Tool', 'create-post')
      .send({ content: { text: 'must not publish' } });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('capability_revoked_or_denied');
  });

  it('rejects cross-account resource substitution and wrong-tool capabilities', async () => {
    const crossAccount = claims('create-post', 'social.posts.publish');
    crossAccount.resource.resourceId = 'other-account';
    const crossAccountResponse = await request(appFor(crossAccount).app)
      .post('/posts')
      .set('Authorization', 'Capability cross-account-ticket')
      .set('X-Oxy-Capability-Tool', 'create-post')
      .send({ content: { text: 'must not publish' } });
    expect(crossAccountResponse.status).toBe(403);

    const wrongToolResponse = await request(appFor(claims('get-post', 'social.posts.read')).app)
      .post('/posts')
      .set('Authorization', 'Capability read-ticket')
      .set('X-Oxy-Capability-Tool', 'create-post')
      .send({ content: { text: 'must not publish' } });
    expect(wrongToolResponse.status).toBe(403);
  });
});
