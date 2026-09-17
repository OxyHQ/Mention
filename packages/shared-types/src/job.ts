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

import type * as ClarityVocabularies from '@clarity.surf/sdk/vocabularies' with { 'resolution-mode': 'import' };

/**
 * Clarity's closed vocabularies — the SAME arrays `POST /v1/jobs/ingest`
 * validates against, so a value Mention accepts is a value Clarity accepts.
 *
 * `require`, not `import`: this package emits CommonJS, and the SDK's type
 * declarations are ESM-only, which TypeScript refuses to `import` statically
 * from a CommonJS module (TS1479). The SDK ships a CommonJS build under the
 * `require` condition of the same subpath, so the runtime value is the real
 * array and the type is taken from the ESM declarations.
 */
declare const require: (id: string) => unknown;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vocabularies = require('@clarity.surf/sdk/vocabularies') as typeof ClarityVocabularies;

export type CurrencyCode = ClarityVocabularies.CurrencyCode;
export type CountryCode = ClarityVocabularies.CountryCode;
/** Active ISO 4217 codes, sorted. Localize with `Intl.DisplayNames({ type: 'currency' })`. */
export const CURRENCY_CODES: readonly CurrencyCode[] = vocabularies.CURRENCY_CODES;
/** ISO 3166-1 alpha-2 codes, sorted. Localize with `Intl.DisplayNames({ type: 'region' })`. */
export const COUNTRY_CODES: readonly CountryCode[] = vocabularies.COUNTRY_CODES;
export const isCurrencyCode: (value: unknown) => value is CurrencyCode = vocabularies.isCurrencyCode;
export const isCountryCode: (value: unknown) => value is CountryCode = vocabularies.isCountryCode;

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

/**
 * Clarity's own interval vocabulary, ordered by duration. Each value maps 1:1
 * onto schema.org's `unitText` (`HOUR`, `DAY`, `WEEK`, `MONTH`, `YEAR`), which
 * is what `POST /v1/jobs/ingest` validates.
 */
export const MENTION_JOB_SALARY_INTERVALS = ['hour', 'day', 'week', 'month', 'year'] as const;
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

/**
 * A job's location as Mention stores and serves it. Never free text.
 *
 * - A physical place (`placeId` set) is a Clarity/GeoNames place. `countryCode`,
 *   `region` and `city` are DERIVED from `clarity.places.get(placeId)` by the
 *   backend at write time — a client can name the place, never its fields.
 * - A country-only role (`placeId` absent) carries `countryCode` alone.
 */
export interface MentionJobLocation {
  /** GeoNames id of a Clarity place (`https://www.geonames.org/<placeId>`). */
  placeId?: string;
  countryCode: CountryCode;
  /** First-order subdivision name (the place itself when it IS a region). */
  region?: string;
  /** The place name, when the place is a city. */
  city?: string;
}

/**
 * What a client sends for a location: EXACTLY ONE of a place id (from
 * `GET /jobs/places/search`) or a country code for a country-only role. The
 * server resolves the rest.
 */
export type MentionJobLocationInput =
  | { placeId: string; countryCode?: never }
  | { countryCode: CountryCode; placeId?: never };

export interface MentionJobSalary {
  /** Whole, non-negative amounts; at least one of `min`/`max`, and `min <= max`. */
  min?: number;
  max?: number;
  /** ISO 4217, from `CURRENCY_CODES`. Mention never converts between currencies, same contract as Clarity. */
  currency: CurrencyCode;
  interval: MentionJobSalaryInterval;
}

/**
 * A place as `GET /jobs/places/search` returns it — the subset of Clarity's
 * `Place` a location picker needs.
 */
export interface MentionJobPlace {
  id: string;
  kind: 'city' | 'region';
  name: string;
  countryCode: CountryCode;
  /** First-order subdivision name; absent for a region (it is its own subdivision). */
  region?: string;
}

export interface MentionJobPlaceSearchResponse {
  places: MentionJobPlace[];
}

/**
 * The display parts of a location, most specific first and de-duplicated (a
 * region place whose name equals its region appears once). `countryName` maps
 * the ISO code to a name — pass an `Intl.DisplayNames` lookup to localize it;
 * the code itself is used otherwise.
 */
export function mentionJobLocationParts(
  location: MentionJobLocation,
  countryName: (code: CountryCode) => string = (code) => code,
): string[] {
  const parts: string[] = [];
  for (const part of [location.city, location.region, countryName(location.countryCode)]) {
    const value = part?.trim();
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts;
}

/** `Barcelona, Catalonia, Spain` — see {@link mentionJobLocationParts}. */
export function formatMentionJobLocation(
  location: MentionJobLocation,
  countryName?: (code: CountryCode) => string,
): string {
  return mentionJobLocationParts(location, countryName).join(', ');
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
  location?: MentionJobLocationInput;
  workplaceType?: MentionJobWorkplaceType;
  employmentType?: MentionJobEmploymentType;
  salary?: MentionJobSalary;
  skills?: string[];
  applicationMode: MentionJobApplicationMode;
  externalApplyUrl?: string;
  /** Publish immediately instead of saving a draft. Defaults to `false`. */
  publish?: boolean;
}

/** Every field optional; `null` on a clearable field (`location`, `salary`, …) clears it. */
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
  location?: MentionJobLocation;
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
