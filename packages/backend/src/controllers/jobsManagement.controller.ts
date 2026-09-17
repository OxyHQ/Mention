/**
 * Job WRITES — create/edit/publish/pause/close/duplicate. Mounted under
 * `authenticatedApi`, so `req.user` is always present here. Reads live in
 * `jobs.controller.ts` / `routes/jobs.ts`.
 */

import { Response, NextFunction } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { isCheckViolation } from '@oxy.so/db';
import {
  MENTION_JOB_APPLICATION_MODES,
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_SALARY_INTERVALS,
  MENTION_JOB_WORKPLACE_TYPES,
  isCountryCode,
  isCurrencyCode,
  type CountryCode,
  type CurrencyCode,
  type MentionJobLocation,
  type MentionJobLocationInput,
} from '@mention/shared-types';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';
import { requireEmployerAuthority } from '../services/jobAuthority';
import { checkJobEntitlement } from '../services/jobEntitlement';
import { syncJobToClarityInBackground } from '../services/clarityJobsAdapter';
import {
  JobLocationError,
  JobPlacesUnavailableError,
  resolveJobLocation,
  type JobFieldIssue,
} from '../services/jobPlaces';
import {
  createJob,
  getJobById,
  setJobStatus,
  toMentionJobPosting,
  updateJob,
} from '../db/jobs/jobRepository';

/** `mention_jobs.salary_min` / `salary_max` are `integer`. */
const MAX_SALARY_AMOUNT = 2_147_483_647;

/**
 * A location names EXACTLY ONE of a Clarity place (by GeoNames id) or a
 * country. Strict: the old free-text keys (`raw`, `city`, `region`) are
 * rejected rather than silently ignored, and a place's country/region/city are
 * never accepted from the client — `resolveJobLocation` reads them from Clarity.
 */
export const jobLocationInputSchema = z
  .strictObject({
    placeId: z
      .string()
      .regex(/^[1-9][0-9]{0,11}$/, 'location.placeId must be a GeoNames place id from /jobs/places/search')
      .optional(),
    countryCode: z
      .custom<CountryCode>(isCountryCode, 'location.countryCode must be an ISO 3166-1 alpha-2 country code (e.g. "ES")')
      .optional(),
  })
  .refine((location) => (location.placeId === undefined) !== (location.countryCode === undefined), {
    message: 'location needs exactly one of placeId (a city or region) or countryCode (a country-only role)',
  })
  .transform((location) => location as MentionJobLocationInput);

export const jobSalarySchema = z
  .strictObject({
    min: z.number().int('salary.min must be a whole number').nonnegative('salary.min cannot be negative').max(MAX_SALARY_AMOUNT).optional(),
    max: z.number().int('salary.max must be a whole number').nonnegative('salary.max cannot be negative').max(MAX_SALARY_AMOUNT).optional(),
    currency: z.custom<CurrencyCode>(isCurrencyCode, 'salary.currency must be an ISO 4217 currency code (e.g. "EUR")'),
    interval: z.enum(MENTION_JOB_SALARY_INTERVALS, `salary.interval must be one of ${MENTION_JOB_SALARY_INTERVALS.join(', ')}`),
  })
  .refine((salary) => salary.min !== undefined || salary.max !== undefined, {
    message: 'salary needs at least one of min or max',
    path: ['min'],
  })
  .refine((salary) => salary.min === undefined || salary.max === undefined || salary.min <= salary.max, {
    message: 'salary.min cannot be greater than salary.max',
    path: ['max'],
  });

export const createJobSchema = z
  .object({
    employerOxyUserId: z.string().min(1, 'employerOxyUserId is required'),
    title: z.string().min(1, 'title is required').max(200),
    description: z.string().min(1, 'description is required'),
    location: jobLocationInputSchema.optional(),
    workplaceType: z.enum(MENTION_JOB_WORKPLACE_TYPES).optional(),
    employmentType: z.enum(MENTION_JOB_EMPLOYMENT_TYPES).optional(),
    salary: jobSalarySchema.optional(),
    skills: z.array(z.string()).max(50).optional(),
    applicationMode: z.enum(MENTION_JOB_APPLICATION_MODES),
    externalApplyUrl: z.string().url().optional(),
    publish: z.boolean().optional(),
  })
  .refine((data) => data.applicationMode !== 'external' || Boolean(data.externalApplyUrl), {
    message: 'externalApplyUrl is required when applicationMode is external',
    path: ['externalApplyUrl'],
  });

export const updateJobSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).optional(),
    location: jobLocationInputSchema.nullish(),
    workplaceType: z.enum(MENTION_JOB_WORKPLACE_TYPES).nullish(),
    employmentType: z.enum(MENTION_JOB_EMPLOYMENT_TYPES).nullish(),
    salary: jobSalarySchema.nullish(),
    skills: z.array(z.string()).max(50).optional(),
    applicationMode: z.enum(MENTION_JOB_APPLICATION_MODES).optional(),
    externalApplyUrl: z.string().url().nullish(),
  })
  // Mirrors createJobSchema's refine: a patch that SWITCHES applicationMode to
  // 'external' must supply the URL in the SAME patch — the row's existing
  // externalApplyUrl is guaranteed null coming from 'mention' mode (the DB
  // CHECK enforces that), so there is never an old value to fall back on.
  // A patch that leaves applicationMode untouched needs no check here at all.
  .refine((data) => data.applicationMode !== 'external' || Boolean(data.externalApplyUrl), {
    message: 'externalApplyUrl is required when setting applicationMode to external',
    path: ['externalApplyUrl'],
  });

/**
 * `400 { error, message, issues }`. `message` is the first problem (what a
 * simple client shows); `issues` names every rejected field so a form can mark
 * each one.
 */
function validationError(res: Response, issues: JobFieldIssue[]) {
  return res.status(400).json({
    error: 'Validation error',
    message: issues[0]?.message ?? 'Invalid request body',
    issues,
  });
}

function zodIssues(error: z.ZodError): JobFieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(body)',
    message: issue.message,
  }));
}

/**
 * Resolve a request's location against Clarity, answering the response itself
 * when that fails: `undefined` means "a response was sent, stop".
 */
async function resolveLocationOrRespond(
  input: MentionJobLocationInput,
  res: Response,
): Promise<MentionJobLocation | undefined> {
  try {
    return await resolveJobLocation(input);
  } catch (error) {
    if (error instanceof JobLocationError) {
      validationError(res, error.issues);
      return undefined;
    }
    if (error instanceof JobPlacesUnavailableError) {
      res.status(503).json({ error: 'Service unavailable', message: error.message });
      return undefined;
    }
    throw error;
  }
}

/**
 * Shared body for `publish` / `pause` / `close` — same authority check, same
 * sync trigger, different target status.
 *
 * A MODULE FUNCTION, deliberately not a class method: Express registers every
 * handler below DETACHED (`router.post('/:id/publish', jobsManagementController.publish)`),
 * so a handler that called a shared body through the receiver would find
 * `this` undefined at call time — the exact bug `polls.controller.ts` already
 * hit in production (recorded in its `serializePoll` docblock).
 */
async function transitionJobStatus(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  targetStatus: 'published' | 'paused' | 'closed',
) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const jobId = req.params.id as string;

    const existing = await getJobById(jobId);
    if (!existing) return res.status(404).json({ error: 'Not found', message: 'Job not found' });

    if (!(await requireEmployerAuthority(existing.employerOxyUserId, req, res))) return;

    if (targetStatus === 'published') {
      const entitlement = await checkJobEntitlement(existing.employerOxyUserId);
      if (!entitlement.canPublish) {
        return res.status(402).json({ error: entitlement.reason ?? 'This account cannot publish a job right now' });
      }
    }

    const row = await setJobStatus(jobId, targetStatus);
    if (!row) return res.status(404).json({ error: 'Not found', message: 'Job not found' });
    const job = toMentionJobPosting(row);
    // Every transition re-syncs Clarity: publish makes it discoverable, pause
    // and close both invalidate the previously-indexed representation.
    syncJobToClarityInBackground(row);
    res.json({ job });
  } catch (error) {
    logger.error(`[JobsManagement] Error transitioning job to ${targetStatus}:`, error);
    next(createError(500, `Error updating job status`));
  }
}

class JobsManagementController {
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const parsed = createJobSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, zodIssues(parsed.error));
      const { location: locationInput, ...input } = parsed.data;

      if (!(await requireEmployerAuthority(input.employerOxyUserId, req, res))) return;

      if (input.publish) {
        const entitlement = await checkJobEntitlement(input.employerOxyUserId);
        if (!entitlement.canPublish) {
          return res.status(402).json({ error: entitlement.reason ?? 'This account cannot publish a job right now' });
        }
      }

      // After the authority check: only an operator of the employer may make
      // Mention spend a Clarity lookup.
      let location: MentionJobLocation | undefined;
      if (locationInput) {
        location = await resolveLocationOrRespond(locationInput, res);
        if (!location) return;
      }

      const row = await createJob({ ...input, location, authorOxyUserId: userId });
      const job = toMentionJobPosting(row);
      if (job.status === 'published') syncJobToClarityInBackground(row);
      res.status(201).json({ job });
    } catch (error) {
      if (isCheckViolation(error)) return validationError(res, [{ path: '(body)', message: 'Job failed validation' }]);
      logger.error('[JobsManagement] Error in create:', error);
      next(createError(500, 'Error creating job'));
    }
  }

  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const jobId = req.params.id as string;

      const existing = await getJobById(jobId);
      if (!existing) return res.status(404).json({ error: 'Not found', message: 'Job not found' });

      if (!(await requireEmployerAuthority(existing.employerOxyUserId, req, res))) return;

      const parsed = updateJobSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, zodIssues(parsed.error));
      const { location: locationInput, ...patch } = parsed.data;

      // `undefined` leaves the location alone, `null` clears it, a value is resolved.
      let location: MentionJobLocation | null | undefined = locationInput === null ? null : undefined;
      if (locationInput) {
        location = await resolveLocationOrRespond(locationInput, res);
        if (!location) return;
      }

      const row = await updateJob(jobId, { ...patch, location });
      if (!row) return res.status(404).json({ error: 'Not found', message: 'Job not found' });
      const job = toMentionJobPosting(row);
      if (job.status === 'published') syncJobToClarityInBackground(row);
      res.json({ job });
    } catch (error) {
      if (isCheckViolation(error)) return validationError(res, [{ path: '(body)', message: 'Job failed validation' }]);
      logger.error('[JobsManagement] Error in update:', error);
      next(createError(500, 'Error updating job'));
    }
  }

  async publish(req: AuthRequest, res: Response, next: NextFunction) {
    return transitionJobStatus(req, res, next, 'published');
  }

  async pause(req: AuthRequest, res: Response, next: NextFunction) {
    return transitionJobStatus(req, res, next, 'paused');
  }

  async close(req: AuthRequest, res: Response, next: NextFunction) {
    return transitionJobStatus(req, res, next, 'closed');
  }

  /** `POST /jobs/:id/duplicate` — a new draft seeded from an existing job's fields. Never copies status/slug/applications. */
  async duplicate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const jobId = req.params.id as string;

      const existing = await getJobById(jobId);
      if (!existing) return res.status(404).json({ error: 'Not found', message: 'Job not found' });

      if (!(await requireEmployerAuthority(existing.employerOxyUserId, req, res))) return;

      const source = toMentionJobPosting(existing);
      const row = await createJob({
        employerOxyUserId: source.employerOxyUserId,
        authorOxyUserId: userId,
        title: `${source.title} (copy)`,
        description: source.description,
        location: source.location,
        workplaceType: source.workplaceType,
        employmentType: source.employmentType,
        salary: source.salary,
        skills: source.skills,
        applicationMode: source.applicationMode,
        externalApplyUrl: source.externalApplyUrl,
        publish: false,
      });
      res.status(201).json({ job: toMentionJobPosting(row) });
    } catch (error) {
      logger.error('[JobsManagement] Error in duplicate:', error);
      next(createError(500, 'Error duplicating job'));
    }
  }
}

export default new JobsManagementController();
