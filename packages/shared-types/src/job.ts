/**
 * Mention-owned job listing types (OxyHQ/Mention#952).
 *
 * Ownership split: Clarity (`@clarity.surf/sdk`) owns global employment
 * discovery/search/ranking over public listings. Mention owns only the
 * authoritative record and lifecycle for a job IT authored — created by an
 * eligible Oxy account (organization/project), published through Mention's
 * employer dashboard, and mirrored to Clarity's index through
 * `clarity.jobs.ingest` (see `services/clarityJobsAdapter.ts` in the backend).
 * Mention never stores Clarity's external-index corpus, and Clarity never
 * becomes the source of truth for a Mention-authored job.
 */

export const MENTION_JOB_WORKPLACE_TYPES = ['onsite', 'hybrid', 'remote'] as const;
export type MentionJobWorkplaceType = (typeof MENTION_JOB_WORKPLACE_TYPES)[number];

export const MENTION_JOB_EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'internship',
  'other',
] as const;
export type MentionJobEmploymentType = (typeof MENTION_JOB_EMPLOYMENT_TYPES)[number];

export const MENTION_JOB_SALARY_INTERVALS = ['hour', 'day', 'month', 'year'] as const;
export type MentionJobSalaryInterval = (typeof MENTION_JOB_SALARY_INTERVALS)[number];

export const MENTION_JOB_APPLICATION_MODES = ['mention', 'external'] as const;
export type MentionJobApplicationMode = (typeof MENTION_JOB_APPLICATION_MODES)[number];

/**
 * `draft` and `expired` are never set by a client request — `draft` is the
 * row's birth state and `expired` is set by the closesAt sweep. Every other
 * transition (`publish`/`pause`/`close`) is an explicit employer action.
 */
export const MENTION_JOB_STATUSES = ['draft', 'published', 'paused', 'closed', 'expired'] as const;
export type MentionJobStatus = (typeof MENTION_JOB_STATUSES)[number];

/**
 * v1 employer eligibility (issue #952 "First-party Mention-authored jobs").
 * `channel`, `bot` and `personal` accounts may never be named as a job's
 * employer — enforced backend-side by `services/jobAuthority.ts`, which layers
 * this restriction on top of `assertCanPublishAsAccount`'s own kind gate.
 */
export const MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS = ['organization', 'project'] as const;

export interface MentionJobLocation {
  /** Free-text as the employer entered it — the only field guaranteed present. */
  raw: string;
  countryCode?: string;
  region?: string;
  city?: string;
}

export interface MentionJobSalary {
  min?: number;
  max?: number;
  /** ISO 4217. Mention never converts between currencies, same contract as Clarity. */
  currency: string;
  interval: MentionJobSalaryInterval;
}

/** Bookkeeping for the retryable, idempotent Clarity indexing sync — never client-writable. */
export type MentionJobClaritySyncStatus = 'pending' | 'synced' | 'failed';

export interface MentionJobPosting {
  id: string;
  /** The Oxy organization/project account this job is published under. */
  employerOxyUserId: string;
  /** Who created the row, for audit only — current management authority is always re-checked live. */
  authorOxyUserId: string;
  title: string;
  description: string;
  location?: MentionJobLocation;
  workplaceType?: MentionJobWorkplaceType;
  employmentType?: MentionJobEmploymentType;
  salary?: MentionJobSalary;
  skills: string[];
  applicationMode: MentionJobApplicationMode;
  /** Required when `applicationMode` is `'external'`. */
  externalApplyUrl?: string;
  status: MentionJobStatus;
  /** URL-safe, unique — the canonical public job page path segment. */
  slug: string;
  canonicalUrl: string;
  /** Count of Mention-native applications; 0 for `applicationMode: 'external'`. */
  applicationCount: number;
  claritySyncStatus: MentionJobClaritySyncStatus;
  publishedAt?: string;
  closesAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMentionJobRequest {
  employerOxyUserId: string;
  title: string;
  description: string;
  location?: MentionJobLocation;
  workplaceType?: MentionJobWorkplaceType;
  employmentType?: MentionJobEmploymentType;
  salary?: MentionJobSalary;
  skills?: string[];
  applicationMode: MentionJobApplicationMode;
  externalApplyUrl?: string;
  /** Publish immediately instead of saving a draft. Defaults to `false`. */
  publish?: boolean;
}

export type UpdateMentionJobRequest = Partial<Omit<CreateMentionJobRequest, 'employerOxyUserId' | 'publish'>>;

export interface MentionJobListFilters {
  employerOxyUserId?: string;
  status?: MentionJobStatus;
  cursor?: string;
  limit?: number;
}

export interface MentionJobListPage {
  jobs: MentionJobPosting[];
  nextCursor?: string;
}

/**
 * What a post attachment resolves to once denormalized server-side — same
 * pattern as `PostPodcastContent`: the client names an id, the server fills
 * in everything else at write time so a stale/adversarial client can never
 * forge an employer name or a closed job's apparent status.
 */
export interface PostJobContent {
  mentionJobId: string;
  title: string;
  employerName: string;
  employerOxyUserId: string;
  status: MentionJobStatus;
  canonicalUrl: string;
  location?: string;
  workplaceType?: MentionJobWorkplaceType;
  employmentType?: MentionJobEmploymentType;
}

/** What a CLIENT sends when attaching a job to a post: only the Mention job id. */
export interface PostJobInput {
  mentionJobId: string;
}

export const MENTION_JOB_APPLICATION_STATUSES = [
  'new',
  'reviewing',
  'interview',
  'rejected',
  'hired',
  'withdrawn',
] as const;
export type MentionJobApplicationStatus = (typeof MENTION_JOB_APPLICATION_STATUSES)[number];

export interface MentionJobApplicationAnswer {
  question: string;
  answer: string;
}

/**
 * A Mention-native application. Deliberately carries NO reference to the
 * applicant's posts, follows, likes, DMs or social graph — only the fields the
 * applicant explicitly chose to disclose in the consent screen
 * (`SubmitMentionJobApplicationRequest`). See issue #952 "Applications".
 */
export interface MentionJobApplication {
  id: string;
  jobId: string;
  applicantOxyUserId: string;
  displayName?: string;
  contactMethod?: string;
  /** An Oxy file id (uploaded via the existing media upload path), never inline bytes. */
  resumeFileId?: string;
  coverNote?: string;
  portfolioLinks?: string[];
  answers?: MentionJobApplicationAnswer[];
  status: MentionJobApplicationStatus;
  assignedToOxyUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitMentionJobApplicationRequest {
  displayName?: string;
  contactMethod?: string;
  resumeFileId?: string;
  coverNote?: string;
  portfolioLinks?: string[];
  answers?: MentionJobApplicationAnswer[];
}

export interface UpdateMentionJobApplicationStatusRequest {
  status: MentionJobApplicationStatus;
}

export interface MentionJobApplicationNote {
  id: string;
  applicationId: string;
  authorOxyUserId: string;
  note: string;
  createdAt: string;
}

/** Privacy-safe AGGREGATE counters only — never a named-viewer trail. */
export interface MentionJobMetricsSummary {
  jobId: string;
  views: number;
  applyStarts: number;
  externalApplyClicks: number;
  completedApplications: number;
}

export type MentionJobMetricEvent = 'view' | 'apply_start' | 'external_apply_click' | 'application_completed';

/**
 * The publish gate for Phase D. Mention stores no payment/plan state itself —
 * this is a read-through projection of Oxy's own billing entitlement for the
 * employer account (same shape Alia consumes at `/billing/accounts/:id/entitlements`).
 * `canPublish: true` by default in v1 (see issue #952 "Open decisions" — the
 * pricing model itself is explicitly unresolved), so this is the seam a real
 * paid tier plugs into later without moving the call site.
 */
export interface MentionJobEntitlement {
  canPublish: boolean;
  reason?: string;
}

export type MentionJobReportReason =
  | 'scam'
  | 'discriminatory'
  | 'impersonation'
  | 'already_filled'
  | 'duplicate'
  | 'misleading'
  | 'other';
