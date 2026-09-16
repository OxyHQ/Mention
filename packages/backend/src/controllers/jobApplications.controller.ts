/**
 * Job APPLICATION reads/writes (OxyHQ/Mention#952 Phase E) — mounted under
 * `authenticatedApi`, so `req.user` is always present. Sibling to
 * `jobsManagement.controller.ts` (job lifecycle) and `jobs.controller.ts` (job
 * reads); this one owns the applicant/employer application workflow plus the
 * external-Clarity-job report proxy.
 *
 * Two different authority checks live side by side here and must not be
 * confused with each other:
 *  - EMPLOYER actions (list applications, change status, add a note) go
 *    through {@link requireEmployerAuthority} (`assertCanManageJob`).
 *  - APPLICANT actions (submit, withdraw) check only that the caller IS the
 *    applicant (`req.user.id === application.applicantOxyUserId`) — an
 *    applicant needs no organizational authority over anything to manage
 *    their own application, and `assertCanManageJob` would refuse every
 *    applicant outright (they do not operate the employer account).
 *
 * THE PRIVACY INVARIANT (issue #952): "Do not expose unrelated Mention posts,
 * follows, likes, DMs, contacts, inferred interests or social graph to the
 * employer." Every response here is built exclusively from
 * `db/jobs/jobApplicationRepository.ts`'s mappers, which read only the
 * `mention_job_applications*` table family — never `posts`, never
 * `entity_follows`. See `src/__tests__/routes/jobApplicationsPrivacy.test.ts`.
 *
 * Detached-handler discipline: same as `jobsManagement.controller.ts`. Express
 * registers every method below DETACHED (`router.post('/x', controller.method)`),
 * so a handler must never call another through `this.` — `polls.controller.ts`'s
 * `serializePoll` docblock is the production incident this avoids. Shared
 * bodies are module-level functions instead.
 */

import { Response, NextFunction } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { isUniqueViolation } from '@oxy.so/db';
import { MENTION_JOB_APPLICATION_STATUSES } from '@mention/shared-types';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';
import { getClarityClient } from '../utils/clarityClient';
import { requireEmployerAuthority } from '../services/jobAuthority';
import { getJobById, incrementApplicationCount } from '../db/jobs/jobRepository';
import {
  APPLICATION_UNIQUE_CONSTRAINT,
  MalformedCursorError,
  addApplicationNote,
  getApplicationRowById,
  listApplicationNotes,
  listApplicationsByJob,
  submitApplication,
  updateApplicationStatus,
  withdrawApplication,
} from '../db/jobs/jobApplicationRepository';

const answerSchema = z.object({
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(5000),
});

const submitApplicationSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  contactMethod: z.string().min(1).max(200).optional(),
  resumeFileId: z.string().min(1).max(500).optional(),
  coverNote: z.string().max(5000).optional(),
  portfolioLinks: z.array(z.string().url()).max(10).optional(),
  answers: z.array(answerSchema).max(50).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(MENTION_JOB_APPLICATION_STATUSES),
});

const addNoteSchema = z.object({
  note: z.string().min(1).max(5000),
});

/**
 * `@clarity.surf/sdk`'s own `JobReportReason` union, restated as a local
 * runtime array for zod — the SDK ships only the TYPE (`import type`, see
 * `utils/clarityClient.ts`'s `resolution-mode: "import"`), so there is no
 * exported const array to import. Deliberately NOT `MentionJobReportReason`
 * (`@mention/shared-types`): that vocabulary is for a Mention-OWNED job's
 * report, delivered through `services/moderation/subjects/jobSubject.ts`. An
 * EXTERNAL Clarity-indexed job's report body has to match what Clarity's own
 * API accepts, which is a narrower and differently-named set (no
 * `impersonation`).
 */
const CLARITY_JOB_REPORT_REASONS = [
  'scam',
  'already_filled',
  'duplicate',
  'misleading',
  'discriminatory',
  'other',
] as const;

const externalJobReportSchema = z.object({
  reason: z.enum(CLARITY_JOB_REPORT_REASONS),
  detail: z.string().max(2000).optional(),
});

function validationError(res: Response, message: string) {
  return res.status(400).json({ error: 'Validation error', message });
}

function jobNotFound(res: Response) {
  return res.status(404).json({ error: 'Not found', message: 'Job not found' });
}

function applicationNotFound(res: Response) {
  return res.status(404).json({ error: 'Not found', message: 'Application not found' });
}

const APPLICATION_STATUS_VALUES: readonly string[] = MENTION_JOB_APPLICATION_STATUSES;

class JobApplicationsController {
  /**
   * `POST /jobs/:id/applications` — the applicant's own submission. No
   * `assertCanManageJob`: submitting an application is not an employer action,
   * it only requires being signed in.
   */
  async submit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const jobId = req.params.id as string;

      const job = await getJobById(jobId);
      if (!job) return jobNotFound(res);
      if (job.applicationMode !== 'mention') {
        return validationError(res, 'This job does not accept applications through Mention');
      }
      if (job.status !== 'published') {
        return validationError(res, 'This job is not currently accepting applications');
      }

      const parsed = submitApplicationSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
      }

      const result = await submitApplication({ jobId, applicantOxyUserId: userId, ...parsed.data });
      // Only a genuinely NEW applicant grows the count — a reapply overwrites
      // its own prior row (see the repository docblock) and must not be
      // double-counted.
      if (result.isNewApplication) {
        await incrementApplicationCount(jobId, 1);
      }
      res.status(result.isNewApplication ? 201 : 200).json({ application: result.application });
    } catch (error) {
      // The repository's documented concurrent-double-submit race: two
      // requests both saw "no existing row" and both tried to insert. The
      // loser fails the unique constraint here rather than silently
      // clobbering the winner's write; 409 tells the client to retry, and the
      // retry will see the winner's row and update it in place.
      if (isUniqueViolation(error, APPLICATION_UNIQUE_CONSTRAINT)) {
        return res.status(409).json({ error: 'Conflict', message: 'Please try submitting again' });
      }
      logger.error('[JobApplications] Error in submit:', error);
      next(createError(500, 'Error submitting application'));
    }
  }

  /** `GET /jobs/:id/applications` — employer-only. Path kept exact: `mcpCapabilities.ts`'s `get-job-applications` policy names it. */
  async listForEmployer(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const jobId = req.params.id as string;
      const job = await getJobById(jobId);
      if (!job) return jobNotFound(res);

      const authorized = await requireEmployerAuthority(job.employerOxyUserId, req, res);
      if (!authorized) return;

      const statusParam = queryString(req.query.status);
      if (statusParam !== undefined && !APPLICATION_STATUS_VALUES.includes(statusParam)) {
        return validationError(res, `status must be one of: ${APPLICATION_STATUS_VALUES.join(', ')}`);
      }

      const result = await listApplicationsByJob(jobId, {
        status: statusParam as (typeof MENTION_JOB_APPLICATION_STATUSES)[number] | undefined,
        limit: queryInt(req.query.limit),
        cursor: queryString(req.query.cursor),
      });
      res.json(result);
    } catch (error) {
      if (error instanceof MalformedCursorError) {
        return validationError(res, error.message);
      }
      logger.error('[JobApplications] Error in listForEmployer:', error);
      next(createError(500, 'Error listing applications'));
    }
  }

  /** `PUT /jobs/:id/applications/:applicationId` — employer changes an application's status. */
  async updateStatus(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const jobId = req.params.id as string;
      const applicationId = req.params.applicationId as string;
      const job = await getJobById(jobId);
      if (!job) return jobNotFound(res);

      const authorized = await requireEmployerAuthority(job.employerOxyUserId, req, res);
      if (!authorized) return;

      const application = await getApplicationRowById(applicationId);
      if (!application || application.jobId !== jobId) return applicationNotFound(res);

      const parsed = updateStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
      }

      const updated = await updateApplicationStatus(applicationId, parsed.data.status);
      if (!updated) return applicationNotFound(res);
      res.json({ application: updated });
    } catch (error) {
      logger.error('[JobApplications] Error in updateStatus:', error);
      next(createError(500, 'Error updating application status'));
    }
  }

  /** `POST /jobs/:id/applications/:applicationId/notes` — employer's internal note. Never disclosed to the applicant. */
  async addNote(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const jobId = req.params.id as string;
      const applicationId = req.params.applicationId as string;
      const job = await getJobById(jobId);
      if (!job) return jobNotFound(res);

      const authorized = await requireEmployerAuthority(job.employerOxyUserId, req, res);
      if (!authorized) return;

      const application = await getApplicationRowById(applicationId);
      if (!application || application.jobId !== jobId) return applicationNotFound(res);

      const parsed = addNoteSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
      }

      const note = await addApplicationNote({ applicationId, authorOxyUserId: userId, note: parsed.data.note });
      res.status(201).json({ note });
    } catch (error) {
      logger.error('[JobApplications] Error in addNote:', error);
      next(createError(500, 'Error adding application note'));
    }
  }

  /**
   * `GET /jobs/:id/applications/:applicationId/notes` — employer-only. Not in
   * issue #952's minimum route list, added alongside `addNote` so a note the
   * employer just wrote is actually readable back through the API.
   */
  async listNotes(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const jobId = req.params.id as string;
      const applicationId = req.params.applicationId as string;
      const job = await getJobById(jobId);
      if (!job) return jobNotFound(res);

      const authorized = await requireEmployerAuthority(job.employerOxyUserId, req, res);
      if (!authorized) return;

      const application = await getApplicationRowById(applicationId);
      if (!application || application.jobId !== jobId) return applicationNotFound(res);

      const notes = await listApplicationNotes(applicationId);
      res.json({ notes });
    } catch (error) {
      logger.error('[JobApplications] Error in listNotes:', error);
      next(createError(500, 'Error listing application notes'));
    }
  }

  /**
   * `POST /jobs/:id/applications/:applicationId/withdraw` — the APPLICANT'S
   * OWN withdrawal. Deliberately NOT `assertCanManageJob`: this checks
   * `req.user.id === application.applicantOxyUserId` instead, because
   * withdrawing is never something an employer operator does.
   */
  async withdraw(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const jobId = req.params.id as string;
      const applicationId = req.params.applicationId as string;

      const application = await getApplicationRowById(applicationId);
      if (!application || application.jobId !== jobId) return applicationNotFound(res);
      if (application.applicantOxyUserId !== userId) {
        return res.status(403).json({ error: 'Forbidden', message: 'You may only withdraw your own application' });
      }

      const updated = await withdrawApplication(applicationId);
      if (!updated) return applicationNotFound(res);

      // `mention_jobs.application_count` counts ALL-TIME submissions, not
      // currently-active ones — see `submit`'s increment and the repository's
      // docblock on `withdrawApplication`. Withdrawing therefore does NOT call
      // `incrementApplicationCount(jobId, -1)`: the field's own name on
      // `MentionJobPosting` ("Count of Mention-native applications") reads as a
      // historical count, and every reader of it (the employer dashboard, the
      // Clarity mirror) only has to agree on "how many people applied, ever" —
      // not renegotiate what "currently active" means every time a status
      // changes.
      res.json({ application: updated });
    } catch (error) {
      logger.error('[JobApplications] Error in withdraw:', error);
      next(createError(500, 'Error withdrawing application'));
    }
  }

  /**
   * `POST /jobs/external/:clarityJobId/report` — a report about a job Mention
   * does not own (Clarity-indexed only). Proxied through Mention's backend
   * because the Clarity client authenticates with Mention's own service
   * credential (`getClarityClient` / `getServiceOxyClient`) — it must never be
   * callable client-side. A Mention-OWNED job's report goes through the
   * ordinary `/reports` surface instead (`reportedType: 'job'`, delivered by
   * `services/moderation/subjects/jobSubject.ts`).
   */
  async reportExternal(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const clarityJobId = req.params.clarityJobId as string;

      const parsed = externalJobReportSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
      }

      const client = await getClarityClient();
      const result = await client.jobs.report(clarityJobId, parsed.data);
      res.json(result);
    } catch (error) {
      logger.error('[JobApplications] Error reporting external job:', error);
      next(createError(502, 'Unable to submit this report to Clarity right now'));
    }
  }
}

export default new JobApplicationsController();
