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

import type { MentionJobEmploymentType, MentionJobPosting } from '@mention/shared-types';
import { config } from '../config';
import { getClarityClient } from '../utils/clarityClient';
import { logger } from '../utils/logger';
import { resolveMediaRef } from '../utils/mediaResolver';
import { resolveUserSummaries } from './PostHydrationService';
import { isClarityError } from './jobPlaces';
import {
  listFailedClaritySyncs,
  recordClaritySync,
  toMentionJobPosting,
  type MentionJobRow,
} from '../db/jobs/jobRepository';

/** `jobPosting.identifier.name` — the publisher namespace the job id lives in. */
const IDENTIFIER_NAMESPACE = 'Mention';

/** The longest sync error kept on the row; a full issue list for a bad payload fits comfortably. */
const MAX_SYNC_ERROR_LENGTH = 2000;

/** schema.org `employmentType` values — Clarity's normalizer reads exactly these. */
const SCHEMA_EMPLOYMENT_TYPES: Record<MentionJobEmploymentType, string> = {
  full_time: 'FULL_TIME',
  part_time: 'PART_TIME',
  contract: 'CONTRACTOR',
  temporary: 'TEMPORARY',
  internship: 'INTERN',
  other: 'OTHER',
};

/** The employer as `hiringOrganization` states it. */
export interface ClarityHiringOrganization {
  name: string;
  /** The employer's public Mention profile. */
  url?: string;
  logo?: string;
}

/**
 * `schema.org/JobPosting` JSON-LD in the exact shape Clarity's first-party
 * ingest contract validates (`POST /v1/jobs/ingest`, see Clarity's
 * `docs/jobs.mdx` "Ingest contract"), built ONLY from what Mention stores:
 *
 * - a place is `jobLocation.sameAs` (its GeoNames URI) plus a structured
 *   `PostalAddress` whose fields were derived from that same place — never a
 *   free-text `streetAddress`;
 * - a country-only role is a `PostalAddress` with `addressCountry` alone;
 * - `baseSalary` carries an ISO 4217 currency, JSON-number amounts and an
 *   upper-case `unitText`, and is omitted when no amount is stated (Clarity
 *   rejects a salary with no amount rather than guessing one);
 * - `description` is Mention's plain text, which is valid Markdown.
 */
export function buildJobPostingJsonLd(
  job: MentionJobPosting,
  organization: ClarityHiringOrganization,
  now: Date = new Date(),
): Record<string, unknown> {
  const hiringOrganization: Record<string, unknown> = { '@type': 'Organization', name: organization.name };
  if (organization.url) hiringOrganization.url = organization.url;
  if (organization.logo) hiringOrganization.logo = organization.logo;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description,
    identifier: { '@type': 'PropertyValue', name: IDENTIFIER_NAMESPACE, value: job.id },
    datePosted: (job.publishedAt ?? job.createdAt).slice(0, 10),
    hiringOrganization,
    directApply: job.applicationMode === 'mention',
    url: job.canonicalUrl,
  };

  if (job.employmentType) jsonLd.employmentType = [SCHEMA_EMPLOYMENT_TYPES[job.employmentType]];

  if (job.status === 'closed' || job.status === 'expired') {
    jsonLd.validThrough = now.toISOString();
  } else if (job.closesAt) {
    jsonLd.validThrough = job.closesAt;
  }

  if (job.location) {
    const address: Record<string, unknown> = { '@type': 'PostalAddress' };
    if (job.location.city) address.addressLocality = job.location.city;
    if (job.location.region) address.addressRegion = job.location.region;
    address.addressCountry = job.location.countryCode;
    const place: Record<string, unknown> = { '@type': 'Place' };
    if (job.location.placeId) place.sameAs = `https://www.geonames.org/${job.location.placeId}`;
    place.address = address;
    jsonLd.jobLocation = [place];
  }
  if (job.workplaceType === 'remote') jsonLd.jobLocationType = 'TELECOMMUTE';

  if (job.salary && (job.salary.min !== undefined || job.salary.max !== undefined)) {
    const value: Record<string, unknown> = { '@type': 'QuantitativeValue' };
    if (job.salary.min !== undefined) value.minValue = job.salary.min;
    if (job.salary.max !== undefined) value.maxValue = job.salary.max;
    value.unitText = job.salary.interval.toUpperCase();
    jsonLd.baseSalary = { '@type': 'MonetaryAmount', currency: job.salary.currency, value };
  }
  return jsonLd;
}

/** The employer's name, profile URL and avatar, from the cached Oxy summary. Never throws. */
export async function resolveHiringOrganization(employerOxyUserId: string): Promise<ClarityHiringOrganization> {
  const summary = await resolveUserSummaries([employerOxyUserId])
    .then((summaries) => summaries.get(employerOxyUserId))
    .catch(() => undefined);
  const user = summary?.user;
  const organization: ClarityHiringOrganization = {
    name: user?.name?.displayName || user?.username || employerOxyUserId,
  };
  if (user?.username) {
    const base = (config.frontendUrl ?? 'https://mention.earth').replace(/\/$/, '');
    organization.url = `${base}/@${user.username}`;
  }
  const logo = typeof user?.avatar === 'string' ? resolveMediaRef(user.avatar).url : '';
  if (logo) organization.logo = logo;
  return organization;
}

/**
 * The sync error recorded on the row. A `400 invalid_job_posting` names every
 * rejected field in `details.issues`; those are what an operator needs, so they
 * are kept rather than collapsed into the generic message.
 */
export function describeClaritySyncError(error: unknown): string {
  if (isClarityError(error) && error.code === 'invalid_job_posting') {
    const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
    const described = issues.map((issue) => {
      const { path, code, message } = (issue ?? {}) as { path?: unknown; code?: unknown; message?: unknown };
      return `${String(path ?? '?')}: ${String(code ?? 'invalid')}${message ? ` (${String(message)})` : ''}`;
    });
    const text = described.length > 0 ? `invalid_job_posting: ${described.join('; ')}` : `invalid_job_posting: ${error.message}`;
    return text.slice(0, MAX_SYNC_ERROR_LENGTH);
  }
  return (error instanceof Error ? error.message : 'unknown').slice(0, MAX_SYNC_ERROR_LENGTH);
}

/**
 * Ingest (or re-ingest) one job's current state into Clarity. Never throws —
 * every failure is caught, logged and recorded on the row via
 * `recordClaritySync` so the caller can surface a "not yet indexed" state
 * without the write path itself failing.
 */
export async function syncJobToClarity(row: MentionJobRow): Promise<void> {
  const job = toMentionJobPosting(row);
  try {
    const organization = await resolveHiringOrganization(job.employerOxyUserId);
    const client = await getClarityClient();
    const result = await client.jobs.ingest(
      {
        url: job.canonicalUrl,
        jobPosting: buildJobPostingJsonLd(job, organization),
        closed: job.status === 'closed' || job.status === 'expired',
      },
      { idempotencyKey: `mention-job-${job.id}-${job.updatedAt}` },
    );
    await recordClaritySync(job.id, {
      status: 'synced',
      clarityDocumentId: result.job?.id ?? result.job?.documentId,
    });
  } catch (error) {
    const reason = describeClaritySyncError(error);
    logger.warn('[ClarityJobsAdapter] Sync failed', { jobId: job.id, reason });
    await recordClaritySync(job.id, { status: 'failed', error: reason }).catch((persistError) => {
      logger.warn('[ClarityJobsAdapter] Failed to record sync failure', {
        jobId: job.id,
        reason: persistError instanceof Error ? persistError.message : 'unknown',
      });
    });
  }
}

/** Fire-and-forget wrapper — the shape every write-path caller actually uses. */
export function syncJobToClarityInBackground(row: MentionJobRow): void {
  void syncJobToClarity(row);
}

/**
 * Re-attempt every job whose last Clarity sync failed. Best-effort and
 * idempotent (`jobs.ingest` is keyed by the job's canonical URL, so a repeat
 * ingest of unchanged content is a no-op on Clarity's side); errors for one job
 * never stop the batch.
 */
export async function retryFailedClarityJobSyncs(limit = 50): Promise<void> {
  const rows = await listFailedClaritySyncs(limit);
  for (const row of rows) {
    await syncJobToClarity(row);
  }
}
