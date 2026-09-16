import { getJobById, toMentionJobPosting } from '../../../db/jobs/jobRepository';
import type { ModerationSubjectProvider, ModerationSubjectSnapshot } from './types';

/**
 * A Mention-owned job listing, as universal material (OxyHQ/Mention#952 Phase
 * E). This is the DELIVERY half only — the `reports` table's
 * `reported_type` CHECK constraint already admits `'job'`
 * (`db/schema/moderation.ts`), so `POST /reports` already accepts and stores
 * one; this file is what makes a stored `job` report actually LEAVE Mention
 * for review, by registering a provider in `registry.ts`.
 *
 * `subjectType: 'social.job_listing'` — namespaced alongside `social.post` and
 * `social.comment` (`postSubject.ts`) rather than under a generic commerce
 * category (`commerce.listing`, which Mercaria and Homiio use for a product):
 * a Mention job posting is a first-party Mention social object with an
 * author and a visibility lifecycle, not a marketplace listing Mention
 * intermediates payment for.
 *
 * An EXTERNAL, Clarity-only job (one Mention did not author) has no row here
 * at all and so has no provider path — its report goes through Clarity's own
 * mechanism instead, proxied by `POST /jobs/external/:clarityJobId/report`
 * (`controllers/jobApplications.controller.ts`). This provider only ever
 * resolves a Mention-authored `mention_jobs` row.
 *
 * No `urgencySnapshot`. `mention_job_daily_metrics` does hold an aggregate
 * view count Mention could compute a `reach` figure from, but wiring a second
 * repository's reads into intake is a v1 scope decision this integration does
 * not need to make yet — omitting the field costs queue position only (see
 * `types.ts`'s own docblock on why that is the safe default), never a
 * disclosure.
 */

/** Content length CrowdSource accepts inline, same bound `postSubject.ts` uses. */
const MAX_CONTEXT_TEXT_LENGTH = 4_000;

export function createJobSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'job',
    subjectType: 'social.job_listing',

    /**
     * Disclose the listing only when it is safe to show outside Mention —
     * same rule `postSubject.ts`'s `loadPost` applies, for the identical
     * reason: CrowdSource delivery runs asynchronously with no reporter
     * credentials to re-check authority live. A `draft` job is visible to
     * nobody but the account that authored it; every other status
     * (`published`, `paused`, `closed`, `expired`) already has, or once had, a
     * public canonical page, so it is fair material for a report either way.
     */
    async snapshot(reportedId: string, reporterId?: string): Promise<ModerationSubjectSnapshot | null> {
      const row = await getJobById(reportedId);
      if (!row) return null;
      if (row.status === 'draft' && row.authorOxyUserId !== reporterId) return null;

      const job = toMentionJobPosting(row);
      const body = [job.title, job.description].filter(Boolean).join('\n\n').slice(0, MAX_CONTEXT_TEXT_LENGTH);

      return {
        subject: {
          externalId: job.id,
          type: 'social.job_listing',
          permalink: job.canonicalUrl,
          // The EMPLOYER account, not `authorOxyUserId` — a report about a job
          // listing is a report about the organization/project it was
          // published under, matching what a reader (and Clarity's own index)
          // sees as "who is behind this listing". `authorOxyUserId` is
          // audit-only bookkeeping for who clicked publish (see
          // `db/schema/jobs.ts`), never disclosed as authorship here.
          author: { oxyUserId: job.employerOxyUserId },
        },
        content: {
          type: 'text',
          data: { text: body },
        },
      };
    },
  };
}
