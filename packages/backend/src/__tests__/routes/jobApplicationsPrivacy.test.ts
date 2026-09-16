/**
 * THE PRIVACY INVARIANT for Mention-native job applications (OxyHQ/Mention#952
 * Phase E): "Do not expose unrelated Mention posts, follows, likes, DMs,
 * contacts, inferred interests or social graph to the employer."
 *
 * Driven through the real router against real Postgres rows, including a real
 * post and a real entity-follow belonging to the applicant — the only way to
 * prove the employer-facing application response is built exclusively from
 * `mention_job_applications` (+ its answers/notes children) and never joins
 * out to `posts` or `entity_follows`, rather than merely asserting it by
 * reading the repository code.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { entityFollows } from '../../db/schema/engagement';
import { mentionJobs } from '../../db/schema/jobs';
import { createJob, type MentionJobRow } from '../../db/jobs/jobRepository';
import jobApplicationsRouter from '../../routes/jobApplications';

const run = randomUUID();
const APPLICANT_ID = `applicant-${run}`;
const EMPLOYER_ID = `employer-${run}`;
const EMPLOYER_OPERATOR_ID = `operator-${run}`;
const STRANGER_ID = `stranger-${run}`;

/** Resolves `EMPLOYER_ID`'s Oxy account kind as `organization` — what `assertCanManageJob` requires to admit it at all. */
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

/** `EMPLOYER_OPERATOR_ID` is an active member of `EMPLOYER_ID` with `account:act_as`; nobody else is a member of anything. */
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
// A per-request caller id, set by header rather than fixed — this suite drives
// the SAME router as both the applicant and the employer's operator.
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  const testUser = req.header('x-test-user');
  if (testUser) req.user = { id: testUser };
  next();
});
app.use('/jobs', jobApplicationsRouter);

/** Every field {@link MentionJobApplication} (`@mention/shared-types`) is allowed to carry. */
const ALLOWED_APPLICATION_FIELDS = new Set([
  'id',
  'jobId',
  'applicantOxyUserId',
  'displayName',
  'contactMethod',
  'resumeFileId',
  'coverNote',
  'portfolioLinks',
  'answers',
  'status',
  'assignedToOxyUserId',
  'createdAt',
  'updatedAt',
]);

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
  await db.delete(posts).where(eq(posts.oxyUserId, APPLICANT_ID));
  await db.delete(entityFollows).where(eq(entityFollows.userId, APPLICANT_ID));
});

afterAll(async () => {
  await closePostgres();
});

describe('job applications — the privacy invariant', () => {
  it('never discloses the applicant\'s posts or follows to the employer, and returns only MentionJobApplication fields', async () => {
    // The applicant has an active, unrelated social life on Mention: a post and
    // a followed hashtag that has nothing to do with this job application.
    const [leakPost] = await db
      .insert(posts)
      .values({ oxyUserId: APPLICANT_ID })
      .returning({ id: posts.id });
    const LEAKY_HASHTAG = `secret-interest-${run}`;
    await db.insert(entityFollows).values({
      userId: APPLICANT_ID,
      entityType: 'hashtag',
      entityId: LEAKY_HASHTAG,
    });

    const submitRes = await request(app)
      .post(`/jobs/${job.id}/applications`)
      .set('x-test-user', APPLICANT_ID)
      .send({
        displayName: 'Jordan Applicant',
        coverNote: 'I would love to build widgets.',
        answers: [{ question: 'Why widgets?', answer: 'Widgets are great.' }],
      });
    expect(submitRes.status).toBe(201);

    const listRes = await request(app)
      .get(`/jobs/${job.id}/applications`)
      .set('x-test-user', EMPLOYER_OPERATOR_ID);

    expect(listRes.status).toBe(200);
    expect(listRes.body.applications).toHaveLength(1);
    const [application] = listRes.body.applications;
    expect(application.applicantOxyUserId).toBe(APPLICANT_ID);

    // Structural proof: not ONE key on the wire falls outside the contract —
    // there is no `posts`, no `follows`, no `socialGraph`, nothing extra at all.
    for (const key of Object.keys(application)) {
      expect(ALLOWED_APPLICATION_FIELDS.has(key)).toBe(true);
    }

    // Content proof: neither the post's id nor the followed hashtag appears
    // ANYWHERE in the response, at any depth.
    const raw = JSON.stringify(listRes.body);
    expect(raw).not.toContain(leakPost.id);
    expect(raw).not.toContain(LEAKY_HASHTAG);
  });

  it('refuses to list applications for a caller who does not operate the employer account', async () => {
    const res = await request(app)
      .get(`/jobs/${job.id}/applications`)
      .set('x-test-user', STRANGER_ID);

    expect(res.status).toBe(403);
  });
});
