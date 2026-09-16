/**
 * The one-way mirror from a Mention-owned job to Clarity's index
 * (`clarity.jobs.ingest`) — the Phase B integration boundary from issue #952.
 *
 * Mention never writes into a Clarity table and never reads Clarity's corpus
 * into its own storage; this module's only state is the sync bookkeeping
 * columns on `mention_jobs` itself (`recordClaritySync` in `jobRepository.ts`).
 *
 * FAIL-SOFT, ALWAYS. A Clarity outage must never fail a draft save, a publish,
 * or any other employer action — every entry point here catches its own
 * errors, records `claritySyncStatus: 'failed'` and returns, mirroring the
 * existing `postEnrichment/clarityDocumentStep.ts` best-effort pattern for
 * link-preview warms.
 *
 * RETRY. There is no separate queue: `retryFailedClarityJobSyncs` re-attempts
 * every job whose last sync failed, and the job read paths
 * (`controllers/jobs.controller.ts`) call it lazily, fire-and-forget, whenever
 * they serve a job still carrying `claritySyncStatus: 'failed'` — the same
 * "best effort on the next natural touch" shape `warmClarityDocumentForText`
 * already uses for post link previews, so a stuck sync heals itself the next
 * time anyone looks at the job rather than needing dedicated scheduler infra.
 */

import type { MentionJobPosting } from '@mention/shared-types';
import { getClarityClient } from '../utils/clarityClient';
import { logger } from '../utils/logger';
import {
  listFailedClaritySyncs,
  recordClaritySync,
  toMentionJobPosting,
  type MentionJobRow,
} from '../db/jobs/jobRepository';

/** `schema.org/JobPosting` JSON-LD, built ONLY from what Mention itself stores. */
function buildJobPostingJsonLd(job: MentionJobPosting, employerName: string): Record<string, unknown> {
  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description,
    datePosted: job.publishedAt,
    hiringOrganization: {
      '@type': 'Organization',
      name: employerName,
    },
    employmentType: job.employmentType?.toUpperCase(),
    directApply: job.applicationMode === 'mention',
  };
  if (job.status === 'closed' || job.status === 'expired') {
    jsonLd.validThrough = new Date().toISOString();
  }
  if (job.location) {
    jsonLd.jobLocation = {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressCountry: job.location.countryCode,
        addressRegion: job.location.region,
        addressLocality: job.location.city,
        streetAddress: job.location.raw,
      },
    };
  }
  if (job.workplaceType === 'remote') jsonLd.jobLocationType = 'TELECOMMUTE';
  if (job.salary) {
    jsonLd.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.salary.currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue: job.salary.min,
        maxValue: job.salary.max,
        unitText: job.salary.interval.toUpperCase(),
      },
    };
  }
  return jsonLd;
}

/**
 * Ingest (or re-ingest) one job's current state into Clarity. Never throws —
 * every failure is caught, logged and recorded on the row via
 * `recordClaritySync` so the caller can surface a "not yet indexed" state
 * without the write path itself failing.
 */
export async function syncJobToClarity(row: MentionJobRow, employerName: string): Promise<void> {
  const job = toMentionJobPosting(row);
  try {
    const client = await getClarityClient();
    const result = await client.jobs.ingest(
      {
        url: job.canonicalUrl,
        jobPosting: buildJobPostingJsonLd(job, employerName),
        closed: job.status === 'closed' || job.status === 'expired',
      },
      { idempotencyKey: `mention-job-${job.id}-${job.updatedAt}` },
    );
    await recordClaritySync(job.id, {
      status: 'synced',
      clarityDocumentId: result.job?.id ?? result.job?.documentId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    logger.warn('[ClarityJobsAdapter] Sync failed', { jobId: job.id, reason });
    await recordClaritySync(job.id, { status: 'failed', error: reason.slice(0, 500) }).catch((persistError) => {
      logger.warn('[ClarityJobsAdapter] Failed to record sync failure', {
        jobId: job.id,
        reason: persistError instanceof Error ? persistError.message : 'unknown',
      });
    });
  }
}

/** Fire-and-forget wrapper — the shape every write-path caller actually uses. */
export function syncJobToClarityInBackground(row: MentionJobRow, employerName: string): void {
  void syncJobToClarity(row, employerName);
}

/**
 * Re-attempt every job whose last Clarity sync failed. Best-effort and
 * idempotent (`jobs.ingest` is keyed by the job's canonical URL, so a repeat
 * ingest of unchanged content is a no-op on Clarity's side); errors for one job
 * never stop the batch.
 */
export async function retryFailedClarityJobSyncs(
  resolveEmployerName: (employerOxyUserId: string) => Promise<string>,
  limit = 50,
): Promise<void> {
  const rows = await listFailedClaritySyncs(limit);
  for (const row of rows) {
    const employerName = await resolveEmployerName(row.employerOxyUserId).catch(() => row.employerOxyUserId);
    await syncJobToClarity(row, employerName);
  }
}
