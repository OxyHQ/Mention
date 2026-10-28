import { ERASURE_STEPS } from '../../services/accountErasure/erasureSteps';
import { applyFileEvent } from '../../services/oxyFiles/fileEvents';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import request from 'supertest';
import { OxyServer, type OxyAuthRequest } from '@oxy.so/core/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { config } from '../../config';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  membershipCommunities,
  membershipContents,
  membershipMedia,
  membershipReports,
} from '../../db/schema/memberships';
import { membershipReviewAudits } from '../../db/schema/membershipModeration';
import { clearRuntimeOxyClient, setRuntimeOxyClient } from '../../runtime/oxyClient';
import type { RequestSafetyContext } from '../../utils/safetyRequester';

const files = vi.hoisted(() => ({
  visibility: 'private',
  withRequester: vi.fn(),
  download: vi.fn(),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({}),
  getServiceOxyClient: () => ({
    assets: {
      withRequester: (proof: unknown) => {
        files.withRequester(proof);
        return {
          linkedDownloadUrls: async (ids: string[]) => {
            await files.download(ids);
            return ids.map((id) => ({
              id,
              visibility: files.visibility,
              url: 'https://files.example/short-lived',
              expiresIn: 300,
            }));
          },
        };
      },
    },
  }),
}));
import { membershipRoutes } from '../../routes/memberships';
let granted = true;
let rolesStatus = 200;
let rolesReads = 0;
let observedBearer: string | undefined;
let proof = 'session';
let communityId = '';
let contentId = '';
let reportId = '';
let mediaId = '';
const authority = createServer((req, res) => {
  rolesReads++;
  observedBearer = req.headers.authorization;
  if (req.url !== `/applications/${config.identity.serviceApplicationId}/roles/me`) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(rolesStatus, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      rolesStatus === 200
        ? {
            applicationId: config.identity.serviceApplicationId,
            userId: 'review-human',
            permissions: granted ? ['memberships.moderate'] : [],
          }
        : { error: 'Permission unavailable' },
    ),
  );
});
const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest & RequestSafetyContext, _res, next) => {
  req.user = { id: 'review-effective-org' };
  req.userId = 'review-effective-org';
  req.sessionId = 'review-session';
  req.accessToken = 'synthetic-original-session';
  if (proof === 'mcp') req.mcp = { activeUserId: 'review-effective-org' };
  if (proof === 'capability') req.capability = { ticket: 'synthetic-task' };
  if (proof === 'missing-session') req.sessionId = null;
  if (proof === 'service')
    req.serviceApp = {
      authority: 'first_party',
      appId: 'synthetic-service',
      appName: 'Fixture',
      tier: 'internal',
      credentialId: 'synthetic-credential',
      ownerAccountId: 'fixture-owner',
      environment: 'test',
    };
  next();
});
app.use('/memberships', membershipRoutes);
const target = () => `/memberships/${communityId}/reports/${reportId}`;
const purpose = 'Investigate the submitted safety report';
beforeAll(async () => {
  await connectPostgres();
  await new Promise<void>((resolve) => authority.listen(0, '127.0.0.1', resolve));
  const address = authority.address();
  if (!address || typeof address === 'string') throw new Error('Authority fixture did not bind');
  setRuntimeOxyClient(new OxyServer({ baseURL: `http://127.0.0.1:${address.port}` }));
});
beforeEach(async () => {
  granted = true;
  rolesStatus = 200;
  rolesReads = 0;
  proof = 'session';
  files.visibility = 'private';
  vi.clearAllMocks();
  communityId = randomUUID();
  contentId = randomUUID();
  reportId = randomUUID();
  mediaId = randomUUID();
  await getDb()
    .insert(membershipCommunities)
    .values({
      id: communityId,
      ownerOxyUserId: 'review-fixture-owner',
      name: 'Protected',
      slug: `review-${communityId}`,
      description: 'Private discussion',
      status: 'active',
    });
  await getDb().insert(membershipContents).values({
    id: contentId,
    communityId,
    authorOxyUserId: 'review-fixture-author',
    kind: 'article',
    body: 'Private reported evidence',
  });
  await getDb().insert(membershipReports).values({
    id: reportId,
    contentId,
    reporterOxyUserId: 'never-return-reporter',
    reason: 'Safety violation',
  });
  await getDb().insert(membershipMedia).values({
    id: mediaId,
    communityId,
    contentId,
    ownerOxyUserId: 'review-fixture-author',
    fileId: randomUUID(),
    mime: 'image/png',
    size: 10,
  });
});
afterAll(async () => {
  clearRuntimeOxyClient();
  await new Promise<void>((resolve, reject) =>
    authority.close((error) => (error ? reject(error) : resolve())),
  );
  await getDb()
    .delete(membershipCommunities)
    .where(eq(membershipCommunities.ownerOxyUserId, 'review-fixture-owner'));
  await closePostgres();
});
describe('report-bound review through the real Oxy app permissions resolver', () => {
  it('commits an audit for the resolved human, never reporter identity or signed media', async () => {
    const result = await request(app).post(`${target()}/inspect`).send({ purpose });
    expect(result.status).toBe(200);
    expect(result.body.data.content.body).toBe('Private reported evidence');
    expect(JSON.stringify(result.body)).not.toContain('never-return-reporter');
    expect(JSON.stringify(result.body)).not.toContain('short-lived');
    expect(observedBearer).toBe('Bearer synthetic-original-session');
    const rows = await getDb()
      .select()
      .from(membershipReviewAudits)
      .where(eq(membershipReviewAudits.reportId, reportId));
    expect(rows).toMatchObject([{ operatorOxyUserId: 'review-human', action: 'inspect', purpose }]);
  });
  it('denies ungranted owners/members and forged permissions headers, including after cached success', async () => {
    expect((await request(app).post(`${target()}/inspect`).send({ purpose })).status).toBe(200);
    granted = false;
    const denied = await request(app)
      .post(`${target()}/inspect`)
      .set('X-Oxy-Permissions', 'memberships.moderate')
      .send({ purpose });
    expect(denied.status).toBe(403);
    expect(rolesReads).toBe(2);
    expect(JSON.stringify(denied.body)).not.toContain('Private reported evidence');
  });
  it.each(['mcp', 'capability', 'service', 'missing-session'])(
    'denies %s proof before contacting authority',
    async (kind) => {
      proof = kind;
      expect((await request(app).post(`${target()}/inspect`).send({ purpose })).status).toBe(403);
      expect(rolesReads).toBe(0);
    },
  );
  it.each([403, 503])('denies an authority refusal/outage %s without evidence', async (status) => {
    rolesStatus = status;
    const result = await request(app).post(`${target()}/inspect`).send({ purpose });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(result.body)).not.toContain('Private reported evidence');
    expect(
      await getDb()
        .select()
        .from(membershipReviewAudits)
        .where(eq(membershipReviewAudits.reportId, reportId)),
    ).toHaveLength(0);
  });
  it('requires exact community/report and content/media binding', async () => {
    expect(
      (
        await request(app)
          .post(`/memberships/another-community/reports/${reportId}/inspect`)
          .send({ purpose })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).post(`${target()}/media/another-media`).send({ purpose })).status,
    ).toBe(404);
    expect(files.download).not.toHaveBeenCalled();
  });
  it('fails closed on audit storage failure before evidence or media delivery', async () => {
    await getDb().execute(
      sql`ALTER TABLE membership_review_audits ADD CONSTRAINT review_fixture_audit_failure CHECK (operator_oxy_user_id <> 'review-human') NOT VALID`,
    );
    try {
      expect((await request(app).post(`${target()}/inspect`).send({ purpose })).status).toBe(500);
      expect(
        (await request(app).post(`${target()}/media/${mediaId}`).send({ purpose })).status,
      ).toBe(500);
      expect(files.download).not.toHaveBeenCalled();
      expect(
        (
          await request(app)
            .post(`${target()}/decision`)
            .send({ action: 'suspend_community', purpose })
        ).status,
      ).toBe(500);
      const [unchanged] = await getDb()
        .select()
        .from(membershipCommunities)
        .where(eq(membershipCommunities.id, communityId));
      expect(unchanged?.status).toBe('active');
    } finally {
      await getDb().execute(
        sql`ALTER TABLE membership_review_audits DROP CONSTRAINT review_fixture_audit_failure`,
      );
    }
  });
  it('uses original operator proof for bound media and refuses fresh public visibility', async () => {
    expect((await request(app).post(`${target()}/media/${mediaId}`).send({ purpose })).status).toBe(
      200,
    );
    expect(files.withRequester).toHaveBeenCalledWith({
      requesterToken: 'synthetic-original-session',
    });
    files.visibility = 'public';
    expect((await request(app).post(`${target()}/media/${mediaId}`).send({ purpose })).status).toBe(
      404,
    );
    expect(rolesReads).toBe(3);
  });
  it.each(['report_erased', 'file_public', 'permission_revoked'])(
    'withholds an old private URL when %s races remote minting',
    async (change) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      files.download.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      const pending = request(app)
        .post(`${target()}/media/${mediaId}`)
        .send({ purpose })
        .then((result) => result);
      await started.promise;
      try {
        if (change === 'report_erased')
          await getDb().delete(membershipReports).where(eq(membershipReports.id, reportId));
        if (change === 'permission_revoked') granted = false;
        if (change === 'file_public') {
          const [media] = await getDb()
            .select()
            .from(membershipMedia)
            .where(eq(membershipMedia.id, mediaId));
          if (!media) throw new Error('Missing media fixture');
          await applyFileEvent({
            id: randomUUID(),
            type: 'file.visibility_changed',
            occurredAt: new Date().toISOString(),
            file: {
              id: media.fileId,
              ownerKind: 'application',
              status: 'active',
              visibility: 'public',
            },
            references: [{ entityType: 'membership_media', entityId: mediaId }],
          });
        }
      } finally {
        release.resolve();
      }
      const result = await pending;
      expect(result.status).toBe(change === 'permission_revoked' ? 403 : 404);
      expect(JSON.stringify(result.body)).not.toContain('short-lived');
    },
  );
  it('can remove reported creator content and suspend its community without membership or manager powers', async () => {
    expect(
      (await request(app).post(`${target()}/decision`).send({ action: 'remove_content', purpose }))
        .status,
    ).toBe(200);
    const [content] = await getDb()
      .select()
      .from(membershipContents)
      .where(eq(membershipContents.id, contentId));
    expect(content?.removedAt).toBeInstanceOf(Date);
    expect(
      (
        await request(app)
          .post(`${target()}/decision`)
          .send({ action: 'suspend_community', purpose })
      ).status,
    ).toBe(200);
    const [community] = await getDb()
      .select()
      .from(membershipCommunities)
      .where(eq(membershipCommunities.id, communityId));
    expect(community?.status).toBe('suspended');
  });
  it('erases reviewer attribution through the canonical account-erasure binding without deleting other evidence', async () => {
    expect((await request(app).post(`${target()}/inspect`).send({ purpose })).status).toBe(200);
    const step = ERASURE_STEPS['membership_review_audits.operatorOxyUserId'];
    if (!step) throw new Error('Missing erasure binding');
    await step.apply({ oxyUserId: 'review-human' });
    const [audit] = await getDb()
      .select()
      .from(membershipReviewAudits)
      .where(eq(membershipReviewAudits.reportId, reportId));
    expect(audit?.operatorOxyUserId).toBeNull();
    expect(audit?.purpose).toBe(purpose);
  });
  it('erasure removes private evidence and its audit without preserving a shadow snapshot', async () => {
    expect((await request(app).post(`${target()}/inspect`).send({ purpose })).status).toBe(200);
    await getDb().delete(membershipContents).where(eq(membershipContents.id, contentId));
    expect((await request(app).post(`${target()}/inspect`).send({ purpose })).status).toBe(404);
    expect(
      await getDb()
        .select()
        .from(membershipReviewAudits)
        .where(eq(membershipReviewAudits.reportId, reportId)),
    ).toHaveLength(0);
  });
});
