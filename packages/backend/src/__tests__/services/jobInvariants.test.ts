/**
 * Two acceptance criteria from OxyHQ/Mention#952 that no single unit owns and
 * are easy to silently regress:
 *
 *  - "Clarity search availability must not be required to save an employer
 *    draft." — the Clarity sync is fire-and-forget
 *    (`syncJobToClarityInBackground`, never awaited by the write path), so a
 *    dead Clarity client must never turn `POST /jobs` / `PUT /jobs/:id` /
 *    publish/pause/close into a failure.
 *  - "Mention should not introduce a second ranking policy" / "Mention
 *    subscription tier, amount paid, company revenue and commercial status
 *    are forbidden search-ranking inputs." — `GET /jobs` maps query params
 *    straight onto Clarity's own `JobSearchRequest` and nothing else; there is
 *    no code path that could inject a commercial signal even by accident,
 *    proven here by asserting the exact key set Clarity actually receives.
 *
 * Both run against the real router with `utils/clarityClient` mocked (never a
 * real Clarity call) and the real Postgres dev database for the write path.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { mentionJobs } from '../../db/schema/jobs';
import { getJobById } from '../../db/jobs/jobRepository';
import jobsRouter from '../../routes/jobs';
import jobsManagementRouter from '../../routes/jobsManagement';

const run = randomUUID();
const EMPLOYER_ID = `employer-${run}`;
const OPERATOR_ID = `operator-${run}`;

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async (ids: string[]) => {
    const summaries = new Map();
    for (const id of ids) {
      if (id === EMPLOYER_ID) {
        summaries.set(id, { user: { id, username: 'acme-hiring', kind: 'organization' } });
      }
    }
    return summaries;
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({
    listAccountMembers: async (accountId: string) =>
      accountId === EMPLOYER_ID
        ? [{ memberUserId: OPERATOR_ID, status: 'active', permissions: ['account:act_as'] }]
        : [],
  }),
}));

/** Captures every `jobs.search` call's request object; `jobs.ingest` always throws — Clarity is entirely unreachable in this suite. */
const searchCalls: unknown[] = [];
const mockJobsClient = {
  search: vi.fn(async (searchRequest: unknown) => {
    searchCalls.push(searchRequest);
    return { data: [], mode: 'lexical' };
  }),
  ingest: vi.fn(async () => {
    throw new Error('Clarity is down');
  }),
};
vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ jobs: mockJobsClient }),
}));

let db: Database;

const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  const testUser = req.header('x-test-user');
  if (testUser) req.user = { id: testUser };
  next();
});
app.use('/jobs', jobsRouter);
app.use('/jobs', jobsManagementRouter);

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  searchCalls.length = 0;
  await db.delete(mentionJobs).where(eq(mentionJobs.employerOxyUserId, EMPLOYER_ID));
});

afterAll(async () => {
  await closePostgres();
});

describe('a dead Clarity client never blocks an employer write', () => {
  it('POST /jobs (draft) succeeds although Clarity is unreachable', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('x-test-user', OPERATOR_ID)
      .send({
        employerOxyUserId: EMPLOYER_ID,
        title: 'Widget Engineer',
        description: 'Build widgets.',
        applicationMode: 'external',
        externalApplyUrl: 'https://example.com/apply',
      });

    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('draft');
  });

  it('POST /jobs (publish: true) still succeeds and returns 201, not a 500 or 502, although the background Clarity sync will fail', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('x-test-user', OPERATOR_ID)
      .send({
        employerOxyUserId: EMPLOYER_ID,
        title: 'Widget Engineer II',
        description: 'Build more widgets.',
        applicationMode: 'external',
        externalApplyUrl: 'https://example.com/apply',
        publish: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('published');

    // The sync was fire-and-forget; give its microtask a turn, then confirm the
    // job row itself survived intact (its authoritative state is never lost or
    // rolled back by a downstream Clarity failure).
    await new Promise((resolve) => setTimeout(resolve, 25));
    const row = await getJobById(res.body.job.id);
    expect(row?.status).toBe('published');
  });

  it('POST /jobs/:id/publish succeeds although Clarity is unreachable', async () => {
    const created = await request(app)
      .post('/jobs')
      .set('x-test-user', OPERATOR_ID)
      .send({
        employerOxyUserId: EMPLOYER_ID,
        title: 'Widget Engineer III',
        description: 'Build widgets, a third time.',
        applicationMode: 'external',
        externalApplyUrl: 'https://example.com/apply',
      });

    const publishRes = await request(app)
      .post(`/jobs/${created.body.job.id}/publish`)
      .set('x-test-user', OPERATOR_ID);

    expect(publishRes.status).toBe(200);
    expect(publishRes.body.job.status).toBe('published');
  });
});

describe('the discovery search proxy carries no commercial ranking signal', () => {
  it('GET /jobs forwards only the documented JobSearchRequest fields to Clarity, never a plan/billing/popularity param', async () => {
    const res = await request(app).get('/jobs').query({
      q: 'engineer',
      location: 'Remote',
      workplaceType: 'remote',
      employmentType: 'full_time',
      salaryMin: '100000',
      salaryCurrency: 'USD',
      limit: '10',
      // Adversarial extras a tampered client might send, none of which are a
      // real JobSearchRequest field — proving they are silently dropped, not
      // forwarded, is the point of this test.
      plan: 'enterprise',
      boost: 'true',
      subscriptionTier: 'gold',
      amountPaid: '999',
    });

    expect(res.status).toBe(200);
    expect(searchCalls).toHaveLength(1);
    const forwarded = searchCalls[0] as Record<string, unknown>;

    const ALLOWED_SEARCH_KEYS = new Set([
      'query',
      'mode',
      'locations',
      'workplaceTypes',
      'employmentTypes',
      'employers',
      'sourceDomains',
      'skills',
      'salary',
      'publishedAfter',
      'publishedBefore',
      'statuses',
      'includeDuplicates',
      'limit',
      'cursor',
    ]);
    for (const key of Object.keys(forwarded)) {
      expect(ALLOWED_SEARCH_KEYS.has(key)).toBe(true);
    }
    // None of the adversarial fields survived under any spelling.
    const raw = JSON.stringify(forwarded);
    expect(raw).not.toMatch(/plan|boost|subscription|amountPaid|enterprise|gold/i);
  });
});
