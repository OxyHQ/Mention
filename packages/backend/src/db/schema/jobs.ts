/**
 * `mention_jobs` + `mention_job_applications` + `mention_job_application_notes`
 * + `mention_job_daily_metrics` — the Mention-owned half of the Clarity Jobs
 * integration (OxyHQ/Mention#952).
 *
 * Mention is the source of truth for a job IT authored. Clarity
 * (`@clarity.surf/sdk`) owns global discovery/search/ranking and receives only
 * a public, indexable representation through `clarity.jobs.ingest` — this
 * schema never stores Clarity's external-index corpus, and the sync bookkeeping
 * columns (`clarity_*`) exist purely to make that one-way mirror retryable and
 * idempotent, never to cache Clarity's own data.
 *
 * `employer_oxy_user_id` names an Oxy organization/project account and carries
 * no foreign key, like every other Oxy account id in this schema (see
 * `CONVENTIONS.md` — "there is no `users` table"). Authority to manage a job is
 * never read off this row: it is re-checked LIVE against Oxy account membership
 * on every mutating call (`services/jobAuthority.ts`), so revoking an
 * organization membership takes effect immediately without touching this table.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';

export const MENTION_JOB_WORKPLACE_TYPES = ['onsite', 'hybrid', 'remote'] as const;
export const MENTION_JOB_EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'internship',
  'other',
] as const;
export const MENTION_JOB_SALARY_INTERVALS = ['hour', 'day', 'month', 'year'] as const;
export const MENTION_JOB_APPLICATION_MODES = ['mention', 'external'] as const;
export const MENTION_JOB_STATUSES = ['draft', 'published', 'paused', 'closed', 'expired'] as const;
export const MENTION_JOB_CLARITY_SYNC_STATUSES = ['pending', 'synced', 'failed'] as const;
export type MentionJobClaritySyncStatus = (typeof MENTION_JOB_CLARITY_SYNC_STATUSES)[number];

/** `mention_jobs` — a Mention-authored, Mention-owned job listing. */
export const mentionJobs = pgTable(
  'mention_jobs',
  {
    id: generatedId(),
    /** An Oxy organization/project account id — no foreign key. */
    employerOxyUserId: text().notNull(),
    /** Who created the row, for audit only — never the authority check. */
    authorOxyUserId: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    locationRaw: text(),
    locationCountryCode: text(),
    locationRegion: text(),
    locationCity: text(),
    workplaceType: text({ enum: MENTION_JOB_WORKPLACE_TYPES }),
    employmentType: text({ enum: MENTION_JOB_EMPLOYMENT_TYPES }),
    salaryMin: integer(),
    salaryMax: integer(),
    /** ISO 4217. Required together with `salaryInterval` — see the CHECK below. */
    salaryCurrency: text(),
    salaryInterval: text({ enum: MENTION_JOB_SALARY_INTERVALS }),
    skills: text().array().notNull().default(sql`'{}'::text[]`),
    applicationMode: text({ enum: MENTION_JOB_APPLICATION_MODES }).notNull().default('external'),
    externalApplyUrl: text(),
    status: text({ enum: MENTION_JOB_STATUSES }).notNull().default('draft'),
    /** URL-safe, unique — the canonical public job page path segment. */
    slug: text().notNull(),
    /** Maintained alongside `mention_job_applications`; the rows are the authority. */
    applicationCount: integer().notNull().default(0),
    /** Retry/idempotency bookkeeping for the one-way Clarity indexing mirror. */
    claritySyncStatus: text({ enum: MENTION_JOB_CLARITY_SYNC_STATUSES }).notNull().default('pending'),
    clarityDocumentId: text(),
    claritySyncedAt: timestamptz(),
    claritySyncError: text(),
    claritySyncAttempts: integer().notNull().default(0),
    publishedAt: timestamptz(),
    closesAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('mention_jobs_application_count_check', sql`${t.applicationCount} >= 0`),
    check('mention_jobs_clarity_sync_attempts_check', sql`${t.claritySyncAttempts} >= 0`),
    check(
      'mention_jobs_status_check',
      sql`${t.status} in (${sql.raw(inList(MENTION_JOB_STATUSES))})`
    ),
    check(
      'mention_jobs_clarity_sync_status_check',
      sql`${t.claritySyncStatus} in (${sql.raw(inList(MENTION_JOB_CLARITY_SYNC_STATUSES))})`
    ),
    // Salary is all-or-nothing on its required half: an amount with no currency
    // or interval is not a fact Clarity (or a reader) can act on. min/max stay
    // independently optional — an employer may publish only a floor or a ceiling.
    check(
      'mention_jobs_salary_complete_check',
      sql`(${t.salaryMin} is null and ${t.salaryMax} is null and ${t.salaryCurrency} is null and ${t.salaryInterval} is null)
        or (${t.salaryCurrency} is not null and ${t.salaryInterval} is not null)`
    ),
    check(
      'mention_jobs_salary_range_check',
      sql`${t.salaryMin} is null or ${t.salaryMax} is null or ${t.salaryMin} <= ${t.salaryMax}`
    ),
    // `applicationMode: 'external'` needs a URL to send an applicant to; `'mention'`
    // must NOT carry one, so a paused external listing can never silently start
    // routing through the wrong mode's UI.
    check(
      'mention_jobs_application_mode_check',
      sql`(${t.applicationMode} = 'external' and ${t.externalApplyUrl} is not null)
        or (${t.applicationMode} = 'mention' and ${t.externalApplyUrl} is null)`
    ),
    uniqueIndex('mention_jobs_slug_key').on(t.slug),
    index('mention_jobs_employer_chrono_idx').on(t.employerOxyUserId, t.createdAt.desc()),
    index('mention_jobs_status_idx').on(t.status),
    // The `closesAt` expiry sweep's range scan.
    index('mention_jobs_closes_at_idx')
      .on(t.closesAt)
      .where(sql`${t.status} = 'published'`),
    index('mention_jobs_clarity_sync_status_idx')
      .on(t.claritySyncStatus)
      .where(sql`${t.claritySyncStatus} = 'failed'`),
  ]
);

/**
 * `mention_job_applications` — a Mention-native application. Carries only what
 * the applicant explicitly chose to disclose (`SubmitMentionJobApplicationRequest`)
 * — no reference to their posts, follows, likes, DMs or social graph. Private by
 * construction: never read by Clarity's indexing sync or ActivityPub federation.
 */
export const mentionJobApplications = pgTable(
  'mention_job_applications',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => mentionJobs.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    applicantOxyUserId: text().notNull(),
    displayName: text(),
    contactMethod: text(),
    /** An Oxy file id (existing media upload path) — never inline bytes. */
    resumeFileId: text(),
    coverNote: text(),
    portfolioLinks: text().array(),
    status: text({ enum: ['new', 'reviewing', 'interview', 'rejected', 'hired', 'withdrawn'] })
      .notNull()
      .default('new'),
    /** An Oxy account id (an operator of the employer account) — no foreign key. */
    assignedToOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'mention_job_applications_status_check',
      sql`${t.status} in ('new','reviewing','interview','rejected','hired','withdrawn')`
    ),
    // One application per applicant per job — resubmitting withdraws and reapplies,
    // it does not duplicate.
    unique('mention_job_applications_job_id_applicant_key').on(t.jobId, t.applicantOxyUserId),
    index('mention_job_applications_job_chrono_idx').on(t.jobId, t.createdAt.desc()),
    index('mention_job_applications_applicant_idx').on(t.applicantOxyUserId),
  ]
);

/**
 * `mention_job_application_answers` — an applicant's response to one
 * employer-defined question. A child table rather than a `jsonb` blob: the
 * schema has exactly four sanctioned `jsonb` columns (see `CONVENTIONS.md`) and
 * a variable-length list of question/answer entities is the "array of entities
 * → real table" case, not the "genuinely shape-less" one.
 */
export const mentionJobApplicationAnswers = pgTable(
  'mention_job_application_answers',
  {
    id: generatedId(),
    applicationId: text()
      .notNull()
      .references(() => mentionJobApplications.id, { onDelete: 'cascade' }),
    question: text().notNull(),
    answer: text().notNull(),
    position: integer().notNull(),
  },
  (t) => [
    check('mention_job_application_answers_position_check', sql`${t.position} >= 0`),
    unique('mention_job_application_answers_application_id_position_key').on(t.applicationId, t.position),
    index('mention_job_application_answers_application_idx').on(t.applicationId),
  ]
);

/** `mention_job_application_notes` — an employer operator's internal note on an application. */
export const mentionJobApplicationNotes = pgTable(
  'mention_job_application_notes',
  {
    id: generatedId(),
    applicationId: text()
      .notNull()
      .references(() => mentionJobApplications.id, { onDelete: 'cascade' }),
    /** An Oxy account id (an operator of the employer account) — no foreign key. */
    authorOxyUserId: text().notNull(),
    note: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('mention_job_application_notes_application_chrono_idx').on(t.applicationId, t.createdAt.desc())]
);

/**
 * `mention_job_daily_metrics` — privacy-safe AGGREGATE counters only, one row
 * per job per UTC day. No named viewer or browsing trail is ever stored here or
 * anywhere else for a job — see issue #952 "Viewing/searching a job does not
 * reveal the viewer's identity to the employer."
 */
export const mentionJobDailyMetrics = pgTable(
  'mention_job_daily_metrics',
  {
    id: generatedId(),
    jobId: text()
      .notNull()
      .references(() => mentionJobs.id, { onDelete: 'cascade' }),
    /** UTC calendar day this row aggregates, stored as a date-only timestamptz at midnight. */
    day: timestamptz().notNull(),
    views: integer().notNull().default(0),
    applyStarts: integer().notNull().default(0),
    externalApplyClicks: integer().notNull().default(0),
    completedApplications: integer().notNull().default(0),
  },
  (t) => [
    check('mention_job_daily_metrics_views_check', sql`${t.views} >= 0`),
    check('mention_job_daily_metrics_apply_starts_check', sql`${t.applyStarts} >= 0`),
    check('mention_job_daily_metrics_external_clicks_check', sql`${t.externalApplyClicks} >= 0`),
    check('mention_job_daily_metrics_completed_applications_check', sql`${t.completedApplications} >= 0`),
    unique('mention_job_daily_metrics_job_id_day_key').on(t.jobId, t.day),
    index('mention_job_daily_metrics_job_chrono_idx').on(t.jobId, t.day.desc()),
  ]
);
