import { authenticatedClient } from '@/utils/api';
import { getErrorMessage, normalizeApiError } from '@/utils/apiError';
import type { JobSearchResponse } from '@clarity.surf/sdk';
import type {
  CountryCode,
  CreateMentionJobRequest,
  MentionJobEmploymentType,
  MentionJobMetricEvent,
  MentionJobMetricsSummary,
  MentionJobPlaceSearchResponse,
  MentionJobPosting,
  MentionJobStatus,
  MentionJobWorkplaceType,
  UpdateMentionJobRequest,
} from '@mention/shared-types';

/** Base path for every job read/write request. */
const JOBS_BASE = '/jobs';

/**
 * Query params for the public Clarity-backed discovery endpoint
 * (`GET /jobs`). Not `MentionJobListFilters` from `@mention/shared-types` —
 * that contract covers only the employer/status/pagination filters shared
 * with the org-scoped list endpoints; discovery adds the public search facets
 * (`q`, location, comp range, `publishedAfter`) the Clarity index exposes.
 *
 * A type alias, not an interface: the HTTP client's `params` takes a
 * `Record` (see `starterPacksService.ts`'s `StarterPackListParams`) — an
 * `interface` here fails `params` assignability with "index signature is
 * missing", since only object-literal type aliases pick up an implicit one.
 */
export type MentionJobDiscoveryFilters = {
  q?: string;
  location?: string;
  workplaceType?: MentionJobWorkplaceType;
  employmentType?: MentionJobEmploymentType;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  /** ISO 8601 — jobs published at or after this instant. */
  publishedAfter?: string;
  /** An employer's Oxy user id — scopes discovery to one employer. */
  employer?: string;
  cursor?: string;
  limit?: number;
};

/** Query params shared by `GET /jobs/mine` and `GET /jobs/organization/:id`. Same type-alias-not-interface reason as {@link MentionJobDiscoveryFilters}. */
export type MentionJobOwnedFilters = {
  status?: MentionJobStatus;
  limit?: number;
};

/** Query params for `GET /jobs/places/search`. Same type-alias-not-interface reason as {@link MentionJobDiscoveryFilters}. */
export type MentionJobPlaceSearchParams = {
  q: string;
  countryCode?: CountryCode;
  kind?: 'city' | 'region';
  limit?: number;
};

export interface MentionJobListResponse {
  jobs: MentionJobPosting[];
  nextCursor?: string;
}

/**
 * `GET /jobs`'s actual response — proxied UNMODIFIED from Clarity
 * (`jobs.controller.ts#search`: `res.json(result)` where `result` is
 * `client.jobs.search(...)`'s own return value). That is `JobSearchResponse`
 * (`{data: JobSearchResult[], nextCursor?, mode, degraded?}`) — a different
 * shape from every other read in this file, none of which is
 * `MentionJobListResponse` (a Mention-authored `{jobs: MentionJobPosting[]}`
 * page). `list()` below is fixed to this shape rather than reusing
 * `MentionJobListResponse`, which was never populated by anything this route
 * returns.
 */
export type MentionJobDiscoveryResponse = JobSearchResponse;

export interface MentionJobCollectionResponse {
  jobs: MentionJobPosting[];
}

export interface MentionJobResponse {
  job: MentionJobPosting;
}

class JobsService {
  /** `GET /jobs` — public Clarity-backed discovery. See {@link MentionJobDiscoveryResponse}. */
  async list(filters?: MentionJobDiscoveryFilters): Promise<MentionJobDiscoveryResponse> {
    const res = await authenticatedClient.get<MentionJobDiscoveryResponse>(JOBS_BASE, { params: filters });
    return res.data;
  }

  /**
   * `GET /jobs/mine` — self-guarded; every job the caller can act on, across
   * every organization/project account they operate.
   */
  async getMine(filters?: MentionJobOwnedFilters): Promise<MentionJobCollectionResponse> {
    const res = await authenticatedClient.get<MentionJobCollectionResponse>(`${JOBS_BASE}/mine`, { params: filters });
    return res.data;
  }

  /** `GET /jobs/organization/:employerOxyUserId` — an org's Jobs tab data. */
  async getOrganizationJobs(
    employerOxyUserId: string,
    filters?: MentionJobOwnedFilters,
  ): Promise<MentionJobCollectionResponse> {
    const res = await authenticatedClient.get<MentionJobCollectionResponse>(
      `${JOBS_BASE}/organization/${employerOxyUserId}`,
      { params: filters },
    );
    return res.data;
  }

  /** `GET /jobs/:id` — canonical public job page. `idOrSlug` accepts either. */
  async get(idOrSlug: string): Promise<MentionJobResponse> {
    const res = await authenticatedClient.get<MentionJobResponse>(`${JOBS_BASE}/${idOrSlug}`);
    return res.data;
  }

  /**
   * `GET /jobs/places/search` — the job form's location autocomplete, proxied
   * to Clarity's gazetteer. A job's `location.placeId` must be one of these ids.
   */
  async searchPlaces(params: MentionJobPlaceSearchParams, signal?: AbortSignal): Promise<MentionJobPlaceSearchResponse> {
    const res = await authenticatedClient.get<MentionJobPlaceSearchResponse>(`${JOBS_BASE}/places/search`, { params, signal });
    return res.data;
  }

  /** `POST /jobs` — 201. Pass `publish: true` to publish immediately instead of saving a draft. */
  async create(input: CreateMentionJobRequest): Promise<MentionJobResponse> {
    const res = await authenticatedClient.post<MentionJobResponse>(JOBS_BASE, input);
    return res.data;
  }

  /** `PUT /jobs/:id` — every field optional; an explicit `null` clears it. */
  async update(id: string, patch: UpdateMentionJobRequest): Promise<MentionJobResponse> {
    const res = await authenticatedClient.put<MentionJobResponse>(`${JOBS_BASE}/${id}`, patch);
    return res.data;
  }

  async publish(id: string): Promise<MentionJobResponse> {
    const res = await authenticatedClient.post<MentionJobResponse>(`${JOBS_BASE}/${id}/publish`);
    return res.data;
  }

  async pause(id: string): Promise<MentionJobResponse> {
    const res = await authenticatedClient.post<MentionJobResponse>(`${JOBS_BASE}/${id}/pause`);
    return res.data;
  }

  async close(id: string): Promise<MentionJobResponse> {
    const res = await authenticatedClient.post<MentionJobResponse>(`${JOBS_BASE}/${id}/close`);
    return res.data;
  }

  /** `POST /jobs/:id/duplicate` — a new draft, "(copy)" appended to the title. */
  async duplicate(id: string): Promise<MentionJobResponse> {
    const res = await authenticatedClient.post<MentionJobResponse>(`${JOBS_BASE}/${id}/duplicate`);
    return res.data;
  }

  /**
   * `POST /jobs/:id/metrics` — public, records one privacy-safe aggregate
   * event (never a named-viewer trail). Callers fire this best-effort and
   * never await/surface its failure — a dropped analytics ping must not
   * affect the page it was recorded from.
   */
  async recordMetric(id: string, event: MentionJobMetricEvent): Promise<void> {
    await authenticatedClient.post(`${JOBS_BASE}/${id}/metrics`, { event });
  }

  /** `GET /jobs/:id/metrics` — employer-only aggregate summary for the job's own dashboard. */
  async getMetrics(id: string): Promise<{ metrics: MentionJobMetricsSummary }> {
    const res = await authenticatedClient.get<{ metrics: MentionJobMetricsSummary }>(`${JOBS_BASE}/${id}/metrics`);
    return res.data;
  }
}

export const jobsService = new JobsService();

/**
 * Fire-and-forget wrapper for {@link JobsService.recordMetric} — the shape
 * every call site actually wants: never awaited, never lets a dropped
 * analytics ping surface as a page error.
 */
export function recordJobMetric(id: string, event: MentionJobMetricEvent): void {
  void jobsService.recordMetric(id, event).catch(() => {});
}

/**
 * `true` when a job write was refused on Oxy's billing entitlement
 * ("This account cannot publish a job right now") — a real, if currently
 * rare, failure mode distinct from a hard validation/auth failure.
 */
export function isJobEntitlementError(error: unknown): boolean {
  return normalizeApiError(error).status === 402;
}

/** `true` when the caller is not an operator of the job's employer account. */
export function isJobForbiddenError(error: unknown): boolean {
  return normalizeApiError(error).status === 403;
}

/**
 * `true` when the failure is an Oxy outage (503) — a genuine "try again"
 * case, distinct from a hard failure that retrying will not fix.
 */
export function isJobServiceUnavailableError(error: unknown): boolean {
  return normalizeApiError(error).status === 503;
}

/** The backend's own `{ error: string }` message, falling back when absent. */
export function getJobErrorMessage(error: unknown, fallback: string): string {
  return getErrorMessage(error, fallback);
}
