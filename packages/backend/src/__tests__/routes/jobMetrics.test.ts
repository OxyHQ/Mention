/**
 * `POST /jobs/:id/metrics` + `GET /jobs/:id/metrics` (OxyHQ/Mention#952 Phase
 * E), driven through the real router against real Postgres rows.
 *
 * Three things this suite exists to prove, none of which a mock-based test on
 * the repository alone would catch:
 *
 * 1. The increment is ATOMIC under real concurrency — `db/jobs/jobMetricsRepository.ts`
 *    documents `onConflictDoUpdate` with a `sql`-computed value specifically to
 *    avoid a read-then-write lost update, and firing several real requests at
 *    once against a real row is the only way to prove that holds.
 * 2. The summary SUMS ACROSS DAYS, not just today's row.
 * 3. `POST` works for a genuinely unauthenticated caller (no `req.user` at
 *    all) while `GET` refuses one who does not operate the employer account —
 *    the public/employer-only split the route split promises.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { mentionJobDailyMetrics, mentionJobs } from '../../db/schema/jobs';
import { createJob, type MentionJobRow } from '../../db/jobs/jobRepository';
import jobMetricsRouter from '../../routes/jobMetrics';

const run = randomUUID();
const EMPLOYER_ID = `employer-${run}`;
const EMPLOYER_OPERATOR_ID = `operator-${run}`;
const STRANGER_ID = `stranger-${run}`;

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async (ids: string[]) => {
    const summaries = new Map();
    for (const id of ids) {
      if (id === EMPLOYER_ID) summaries.set(id, { user: { id, username: 'acme-hiring', kind: 'organization' } });
    }
    return summaries;
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({
    listAccountMembers: async (accountId: string) =>
      accountId === EMPLOYER_ID
        ? [{ memberUserId: EMPLOYER_OPERATOR_ID, status: 'active', permissions: ['account:act_as'] }]
        : [],
  }),
}));

let db: Database;
let job: MentionJobRow;

const app = express();
app.use(express.json());
// `optionalAuth` in production: present ONLY when a test explicitly sets it,
// so the "no header at all" case genuinely exercises an unauthenticated caller.
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  const testUser = req.header('x-test-user');
  if (testUser) req.user = { id: testUser };
  next();
});
app.use('/jobs', jobMetricsRouter);

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(async () => {
  job = await createJob({
    employerOxyUserId: EMPLOYER_ID,
    authorOxyUserId: EMPLOYER_ID,
    title: 'Senior Widget Engineer',
    description: 'Build widgets for a living.',
    applicationMode: 'mention',
    publish: true,
  });
});

afterEach(async () => {
  await db.delete(mentionJobs).where(eq(mentionJobs.id, job.id));
});

afterAll(async () => {
  await closePostgres();
});

describe('POST /jobs/:id/metrics', () => {
  it('counts an anonymous view with no req.user at all', async () => {
    const res = await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'view' });
    expect(res.status).toBe(204);

    const summaryRes = await request(app)
      .get(`/jobs/${job.id}/metrics`)
      .set('x-test-user', EMPLOYER_OPERATOR_ID);
    expect(summaryRes.body.metrics.views).toBe(1);
  });

  it('rejects an event outside the known set', async () => {
    const res = await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'page_view' });
    expect(res.status).toBe(400);
  });

  it('404s a metric event for a job that does not exist', async () => {
    const res = await request(app).post('/jobs/does-not-exist/metrics').send({ event: 'view' });
    expect(res.status).toBe(404);
  });

  it('survives concurrent increments without losing one — the whole point of the atomic upsert', async () => {
    const CONCURRENT_VIEWS = 25;
    await Promise.all(
      Array.from({ length: CONCURRENT_VIEWS }, () =>
        request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'view' }),
      ),
    );

    const summaryRes = await request(app)
      .get(`/jobs/${job.id}/metrics`)
      .set('x-test-user', EMPLOYER_OPERATOR_ID);
    expect(summaryRes.body.metrics.views).toBe(CONCURRENT_VIEWS);
  });

  it('increments the right counter for each distinct event kind, independently', async () => {
    await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'view' });
    await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'view' });
    await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'apply_start' });
    await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'external_apply_click' });
    await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'application_completed' });

    const summaryRes = await request(app)
      .get(`/jobs/${job.id}/metrics`)
      .set('x-test-user', EMPLOYER_OPERATOR_ID);
    expect(summaryRes.body.metrics).toMatchObject({
      jobId: job.id,
      views: 2,
      applyStarts: 1,
      externalApplyClicks: 1,
      completedApplications: 1,
    });
  });
});

describe('GET /jobs/:id/metrics', () => {
  it('sums across every day on record, not just today', async () => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await db.insert(mentionJobDailyMetrics).values({
      jobId: job.id,
      day: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())),
      views: 40,
    });
    await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'view' });

    const summaryRes = await request(app)
      .get(`/jobs/${job.id}/metrics`)
      .set('x-test-user', EMPLOYER_OPERATOR_ID);
    expect(summaryRes.body.metrics.views).toBe(41);
  });

  it('refuses a caller who does not operate the employer account', async () => {
    const res = await request(app).get(`/jobs/${job.id}/metrics`).set('x-test-user', STRANGER_ID);
    expect(res.status).toBe(403);
  });

  it('refuses an entirely unauthenticated caller', async () => {
    const res = await request(app).get(`/jobs/${job.id}/metrics`);
    expect(res.status).toBe(403);
  });

  it('never returns a per-viewer breakdown — only the four aggregate counters', async () => {
    await request(app).post(`/jobs/${job.id}/metrics`).send({ event: 'view' });

    const res = await request(app).get(`/jobs/${job.id}/metrics`).set('x-test-user', EMPLOYER_OPERATOR_ID);
    expect(Object.keys(res.body.metrics).sort()).toEqual(
      ['applyStarts', 'completedApplications', 'externalApplyClicks', 'jobId', 'views'].sort(),
    );
  });
});
