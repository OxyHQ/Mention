import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { managedMentionDeploymentSchema } from '@mention/shared-types/deployment';
import example from '../../../shared-types/__tests__/fixtures/managed-deployment.json';
import { createDeploymentAdmission } from '../middleware/deployment-admission';
import { parseRuntimeEnvironment } from '../config';

const deployment = managedMentionDeploymentSchema.parse(example);
const dedicatedEnvironment = {
  MENTION_DEPLOYMENT_CONFIG: JSON.stringify(example),
  DATABASE_URL: 'postgresql://db.alpha.example/mention_alpha',
  REDIS_URL: 'rediss://cache.alpha.example:6379/0',
  OXY_SERVICE_API_KEY: 'test-tenant-key', OXY_SERVICE_API_SECRET: 'test-tenant-secret',
  MENTION_OXY_CLIENT_ID: 'test-tenant-client', MENTION_SHELL_ACCESS_KEY: 'test-shell-secret-with-at-least-32-characters',
};
function application(effectiveAccountId: string | undefined, publicReads: boolean) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Model the already-verified Oxy identity, not an identity from the request body.
    if (effectiveAccountId) (req as OxyAuthRequest).user = { id: effectiveAccountId };
    next();
  });
  app.use(createDeploymentAdmission(deployment, publicReads));
  app.all('/resource', (_req, res) => res.json({ accepted: true }));
  return app;
}

describe('managed deployment runtime', () => {
  it('uses the validated manifest in the real backend environment parser', () => {
    const parsed = parseRuntimeEnvironment(dedicatedEnvironment);
    expect(parsed.MENTION_PUBLIC_API_URL).toBe(example.apiBaseUrl);
    expect(parsed.FRONTEND_URL).toBe(example.publicBaseUrl);
    expect(parsed.FEDERATION_DOMAIN).toBe('social.alpha.example');
    expect(parsed.ACTOR_DOMAIN).toBe('social.alpha.example');
    expect(parsed.MENTION_MCP_PUBLIC_URL).toBe(example.mcpBaseUrl);
    expect(() => parseRuntimeEnvironment({
      MENTION_DEPLOYMENT_CONFIG: JSON.stringify(example), MENTION_WEB_ORIGIN: 'https://mention.earth',
    })).toThrow('MENTION_WEB_ORIGIN conflicts');
  });

  it('fails closed rather than using development storage or shared service defaults', () => {
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET',
      'MENTION_OXY_CLIENT_ID', 'MENTION_SHELL_ACCESS_KEY']) {
      expect(() => parseRuntimeEnvironment({ ...dedicatedEnvironment, [key]: undefined })).toThrow();
    }
  });

  it('keeps public reads anonymous, but does not let anonymous callers mutate', async () => {
    await request(application(undefined, true)).get('/resource').expect(200);
    await request(application(undefined, true)).head('/resource').expect(200);
    await request(application(undefined, true)).post('/resource').expect(401);
    await request(application(undefined, false)).get('/resource').expect(401);
  });

  it('rejects forged administrator IDs and foreign participants before downstream execution', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      await request(application('member-beta', true))[method]('/resource')
        .set('X-Tenant-Id', deployment.tenantId)
        .send({ userId: 'admin-alpha', oxyUserId: 'admin-alpha', tenantId: deployment.tenantId })
        .expect(403, { error: 'deployment_membership_required', signupPolicy: 'invite' });
    }
    await request(application('member-beta', false)).get('/resource').expect(403);
  });

  it('uses the effective switched account rather than a connection owner or administrator', async () => {
    await request(application('member-alpha', false)).post('/resource').expect(200);
    await request(application('admin-alpha', false)).get('/resource').expect(200);
    await request(application('uninvited-active-account', false)).post('/resource')
      .send({ primaryUserId: 'admin-alpha', activeUserId: 'member-alpha' }).expect(403);
  });
});
