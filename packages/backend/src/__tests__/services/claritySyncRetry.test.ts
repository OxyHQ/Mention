/**
 * The scheduled Clarity job-sync retry: which failed syncs are due (backoff from
 * the last attempt, doubling per failure, and an attempt cap), and that a retry
 * pass re-ingests exactly those and records the outcome.
 *
 * Runs against the real Postgres test database; Clarity and the employer lookup
 * are mocked, so nothing leaves the process.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { mentionJobs } from '../../db/schema/jobs';
import {
  getJobById,
  listFailedClaritySyncs,
  MAX_CLARITY_SYNC_ATTEMPTS,
} from '../../db/jobs/jobRepository';
import { retryFailedClarityJobSyncs } from '../../services/clarityJobsAdapter';

const ingest = vi.fn();
vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ jobs: { ingest } }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

const run = randomUUID();
const EMPLOYER_ID = `clarity-retry-${run}`;
const MINUTE_MS = 60 * 1000;

let db: Database;

/** A published job with the given Clarity sync state, last written `minutesAgo` minutes ago. */
async function insertJob(
  label: string,
  sync: { status: 'pending' | 'synced' | 'failed'; attempts: number; minutesAgo: number },
): Promise<string> {
  const writtenAt = new Date(Date.now() - sync.minutesAgo * MINUTE_MS);
  const [row] = await db
    .insert(mentionJobs)
    .values({
      employerOxyUserId: EMPLOYER_ID,
      authorOxyUserId: EMPLOYER_ID,
      title: `Job ${label}`,
      description: 'd',
      slug: `clarity-retry-${run}-${label}`,
      status: 'published',
      applicationMode: 'mention',
      claritySyncStatus: sync.status,
      claritySyncAttempts: sync.attempts,
      createdAt: writtenAt,
      updatedAt: writtenAt,
    })
    .returning({ id: mentionJobs.id });
  return row.id;
}

/** The due jobs of this run only: other suites share the database. */
async function dueIds(): Promise<string[]> {
  const rows = await listFailedClaritySyncs(1000);
  return rows.filter((row) => row.employerOxyUserId === EMPLOYER_ID).map((row) => row.id);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  ingest.mockReset();
  await db.delete(mentionJobs).where(eq(mentionJobs.employerOxyUserId, EMPLOYER_ID));
});

afterAll(async () => {
  await closePostgres();
});

describe('listFailedClaritySyncs', () => {
  it('waits 10 minutes after the first failure and doubles the wait with each further one', async () => {
    const firstDue = await insertJob('first-due', {
      status: 'failed',
      attempts: 1,
      minutesAgo: 11,
    });
    await insertJob('first-waiting', { status: 'failed', attempts: 1, minutesAgo: 5 });
    const thirdDue = await insertJob('third-due', {
      status: 'failed',
      attempts: 3,
      minutesAgo: 41,
    });
    await insertJob('third-waiting', { status: 'failed', attempts: 3, minutesAgo: 30 });

    expect((await dueIds()).sort()).toEqual([firstDue, thirdDue].sort());
  });

  it('stops scheduling a job once it has failed the maximum number of times', async () => {
    await insertJob('exhausted', {
      status: 'failed',
      attempts: MAX_CLARITY_SYNC_ATTEMPTS,
      minutesAgo: 7 * 24 * 60,
    });
    const lastTry = await insertJob('last-try', {
      status: 'failed',
      attempts: MAX_CLARITY_SYNC_ATTEMPTS - 1,
      minutesAgo: 7 * 24 * 60,
    });

    expect(await dueIds()).toEqual([lastTry]);
  });

  it('never lists a job whose sync did not fail', async () => {
    await insertJob('synced', { status: 'synced', attempts: 0, minutesAgo: 60 });
    await insertJob('pending', { status: 'pending', attempts: 0, minutesAgo: 60 });

    expect(await dueIds()).toEqual([]);
  });
});

describe('retryFailedClarityJobSyncs', () => {
  it('marks a due job synced when Clarity accepts it', async () => {
    ingest.mockResolvedValue({ job: { id: 'clarity-doc-1' } });
    const id = await insertJob('recovers', { status: 'failed', attempts: 2, minutesAgo: 21 });

    await retryFailedClarityJobSyncs(1000);

    const row = await getJobById(id);
    expect(row?.claritySyncStatus).toBe('synced');
    expect(row?.claritySyncAttempts).toBe(0);
    expect(row?.clarityDocumentId).toBe('clarity-doc-1');
  });

  it('counts another failure and backs off, so the next pass does not retry it at once', async () => {
    ingest.mockRejectedValue(new Error('Clarity is down'));
    const id = await insertJob('still-down', { status: 'failed', attempts: 1, minutesAgo: 11 });

    await retryFailedClarityJobSyncs(1000);

    const row = await getJobById(id);
    expect(row?.claritySyncStatus).toBe('failed');
    expect(row?.claritySyncAttempts).toBe(2);
    expect(await dueIds()).toEqual([]);
  });
});
