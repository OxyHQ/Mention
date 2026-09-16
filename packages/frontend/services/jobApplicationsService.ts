import { authenticatedClient } from '@/utils/api';
import type { JobReportReason } from '@clarity.surf/sdk';
import type {
  MentionJobApplication,
  MentionJobApplicationNote,
  MentionJobApplicationStatus,
  SubmitMentionJobApplicationRequest,
} from '@mention/shared-types';

/** Base path for every application read/write request — nested under one job. */
const jobsBase = (jobId: string) => `/jobs/${jobId}`;

/** Query params for `GET /jobs/:id/applications` (employer-only). Type alias, not interface — same `params` assignability reason as `jobsService.ts`'s `MentionJobDiscoveryFilters`. */
export type MentionJobApplicationListFilters = {
  status?: MentionJobApplicationStatus;
  limit?: number;
  cursor?: string;
};

export interface MentionJobApplicationListResponse {
  applications: MentionJobApplication[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface MentionJobApplicationResponse {
  application: MentionJobApplication;
}

export interface MentionJobApplicationNoteListResponse {
  notes: MentionJobApplicationNote[];
}

export interface MentionJobApplicationNoteResponse {
  note: MentionJobApplicationNote;
}

class JobApplicationsService {
  /**
   * `POST /jobs/:id/applications` — the caller's own submission. 201 for a
   * brand-new application, 200 for a resubmission (the backend upserts in
   * place rather than rejecting a reapply) — both return the same shape, so
   * callers that don't care about the distinction can ignore the status code.
   */
  async submit(jobId: string, input: SubmitMentionJobApplicationRequest): Promise<MentionJobApplicationResponse> {
    const res = await authenticatedClient.post<MentionJobApplicationResponse>(
      `${jobsBase(jobId)}/applications`,
      input,
    );
    return res.data;
  }

  /** `GET /jobs/:id/applications` — employer-only. */
  async listForEmployer(
    jobId: string,
    filters?: MentionJobApplicationListFilters,
  ): Promise<MentionJobApplicationListResponse> {
    const res = await authenticatedClient.get<MentionJobApplicationListResponse>(
      `${jobsBase(jobId)}/applications`,
      { params: filters },
    );
    return res.data;
  }

  /** `PUT /jobs/:id/applications/:applicationId` — employer-only. */
  async updateStatus(
    jobId: string,
    applicationId: string,
    status: MentionJobApplicationStatus,
  ): Promise<MentionJobApplicationResponse> {
    const res = await authenticatedClient.put<MentionJobApplicationResponse>(
      `${jobsBase(jobId)}/applications/${applicationId}`,
      { status },
    );
    return res.data;
  }

  /** `POST /jobs/:id/applications/:applicationId/notes` — employer-only, 201. Never disclosed to the applicant. */
  async addNote(jobId: string, applicationId: string, note: string): Promise<MentionJobApplicationNoteResponse> {
    const res = await authenticatedClient.post<MentionJobApplicationNoteResponse>(
      `${jobsBase(jobId)}/applications/${applicationId}/notes`,
      { note },
    );
    return res.data;
  }

  /** `GET /jobs/:id/applications/:applicationId/notes` — employer-only. */
  async listNotes(jobId: string, applicationId: string): Promise<MentionJobApplicationNoteListResponse> {
    const res = await authenticatedClient.get<MentionJobApplicationNoteListResponse>(
      `${jobsBase(jobId)}/applications/${applicationId}/notes`,
    );
    return res.data;
  }

  /** `POST /jobs/:id/applications/:applicationId/withdraw` — applicant-only (must be their own application). */
  async withdraw(jobId: string, applicationId: string): Promise<MentionJobApplicationResponse> {
    const res = await authenticatedClient.post<MentionJobApplicationResponse>(
      `${jobsBase(jobId)}/applications/${applicationId}/withdraw`,
    );
    return res.data;
  }

  /**
   * `POST /jobs/external/:clarityJobId/report` — reports an EXTERNAL
   * (Clarity-indexed-only, not Mention-owned) job listing. Proxied through
   * Mention's backend to Clarity's own report mechanism.
   *
   * `reason` is `@clarity.surf/sdk`'s `JobReportReason`, deliberately NOT
   * `@mention/shared-types`' `MentionJobReportReason` — the backend's
   * `externalJobReportSchema` (`jobApplications.controller.ts`) validates
   * against Clarity's narrower, differently-named vocabulary (no
   * `impersonation`), matching what Clarity's own API accepts. A
   * Mention-OWNED job's report goes through `reportService` instead
   * (`reportedType: 'job'`), never this endpoint.
   */
  async reportExternalJob(
    clarityJobId: string,
    reason: JobReportReason,
    detail?: string,
  ): Promise<unknown> {
    const res = await authenticatedClient.post(`/jobs/external/${clarityJobId}/report`, { reason, detail });
    return res.data;
  }
}

export const jobApplicationsService = new JobApplicationsService();

// Reuse the same error helpers `jobsService.ts` already defines — the failure
// modes (402 entitlement, 403 not-an-operator/not-the-applicant, 503 outage)
// are identical for application writes, so a second copy of the same three
// status-code checks would just be a second place for them to drift apart.
export {
  isJobEntitlementError,
  isJobForbiddenError,
  isJobServiceUnavailableError,
  getJobErrorMessage,
} from './jobsService';
