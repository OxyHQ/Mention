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
} from '@mention/shared-types';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { resolveUserSummaries } from '../services/PostHydrationService';
import { assertCanManageJob } from '../services/jobAuthority';
import { PublishAsAccessError } from '../services/publishAsAccount';
import { checkJobEntitlement } from '../services/jobEntitlement';
import { syncJobToClarityInBackground } from '../services/clarityJobsAdapter';
import {
  createJob,
  getJobById,
  setJobStatus,
  toMentionJobPosting,
  updateJob,
} from '../db/jobs/jobRepository';

const locationSchema = z.object({
  raw: z.string().min(1),
  countryCode: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
});

const salarySchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  currency: z.string().min(1),
  interval: z.enum(MENTION_JOB_SALARY_INTERVALS),
});

const createJobSchema = z
  .object({
    employerOxyUserId: z.string().min(1, 'employerOxyUserId is required'),
    title: z.string().min(1, 'title is required').max(200),
    description: z.string().min(1, 'description is required'),
    location: locationSchema.optional(),
    workplaceType: z.enum(MENTION_JOB_WORKPLACE_TYPES).optional(),
    employmentType: z.enum(MENTION_JOB_EMPLOYMENT_TYPES).optional(),
    salary: salarySchema.optional(),
    skills: z.array(z.string()).max(50).optional(),
    applicationMode: z.enum(MENTION_JOB_APPLICATION_MODES),
    externalApplyUrl: z.string().url().optional(),
    publish: z.boolean().optional(),
  })
  .refine((data) => data.applicationMode !== 'external' || Boolean(data.externalApplyUrl), {
    message: 'externalApplyUrl is required when applicationMode is external',
    path: ['externalApplyUrl'],
  });

const updateJobSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).optional(),
  location: locationSchema.nullish(),
  workplaceType: z.enum(MENTION_JOB_WORKPLACE_TYPES).nullish(),
  employmentType: z.enum(MENTION_JOB_EMPLOYMENT_TYPES).nullish(),
  salary: salarySchema.nullish(),
  skills: z.array(z.string()).max(50).optional(),
  applicationMode: z.enum(MENTION_JOB_APPLICATION_MODES).optional(),
  externalApplyUrl: z.string().url().nullish(),
});

function validationError(res: Response, message: string) {
  return res.status(400).json({ error: 'Validation error', message });
}

async function employerDisplayName(employerOxyUserId: string): Promise<string> {
  const summary = (await resolveUserSummaries([employerOxyUserId])).get(employerOxyUserId);
  return summary?.user.name?.displayName ?? summary?.user.username ?? employerOxyUserId;
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

    try {
      await assertCanManageJob({
        employerOxyUserId: existing.employerOxyUserId,
        callerId: userId,
        memberReader: createUserScopedOxyServices(req),
      });
    } catch (error) {
      if (error instanceof PublishAsAccessError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

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
    syncJobToClarityInBackground(row, await employerDisplayName(job.employerOxyUserId));
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
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
      }
      const input = parsed.data;

      try {
        await assertCanManageJob({
          employerOxyUserId: input.employerOxyUserId,
          callerId: userId,
          memberReader: createUserScopedOxyServices(req),
        });
      } catch (error) {
        if (error instanceof PublishAsAccessError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }

      if (input.publish) {
        const entitlement = await checkJobEntitlement(input.employerOxyUserId);
        if (!entitlement.canPublish) {
          return res.status(402).json({ error: entitlement.reason ?? 'This account cannot publish a job right now' });
        }
      }

      const row = await createJob({ ...input, authorOxyUserId: userId });
      const job = toMentionJobPosting(row);
      if (job.status === 'published') {
        syncJobToClarityInBackground(row, await employerDisplayName(job.employerOxyUserId));
      }
      res.status(201).json({ job });
    } catch (error) {
      if (isCheckViolation(error)) return validationError(res, 'Job failed validation');
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

      try {
        await assertCanManageJob({
          employerOxyUserId: existing.employerOxyUserId,
          callerId: userId,
          memberReader: createUserScopedOxyServices(req),
        });
      } catch (error) {
        if (error instanceof PublishAsAccessError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }

      const parsed = updateJobSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
      }

      const row = await updateJob(jobId, parsed.data);
      if (!row) return res.status(404).json({ error: 'Not found', message: 'Job not found' });
      const job = toMentionJobPosting(row);
      if (job.status === 'published') {
        syncJobToClarityInBackground(row, await employerDisplayName(job.employerOxyUserId));
      }
      res.json({ job });
    } catch (error) {
      if (isCheckViolation(error)) return validationError(res, 'Job failed validation');
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

      try {
        await assertCanManageJob({
          employerOxyUserId: existing.employerOxyUserId,
          callerId: userId,
          memberReader: createUserScopedOxyServices(req),
        });
      } catch (error) {
        if (error instanceof PublishAsAccessError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }

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
