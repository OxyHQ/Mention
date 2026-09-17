/**
 * Job READS. All mounted under `publicApi` with `optionalAuth` — every route
 * here self-guards (elevated results only for a caller with live authority),
 * matching `routes/posts.ts`'s `publicPostsRouter` convention. Mutations live
 * in `jobsManagement.controller.ts` / `routes/jobsManagement.ts`.
 */

import { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import {
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_WORKPLACE_TYPES,
  isCurrencyCode,
  type MentionJobPosting,
} from '@mention/shared-types';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { getClarityClient } from '../utils/clarityClient';
import {
  expireIfDue,
  getJobById,
  getJobBySlug,
  listJobsByEmployer,
  toMentionJobPosting,
  type MentionJobRow,
} from '../db/jobs/jobRepository';
import { assertCanManageJob, listOperatedJobEmployerIds } from '../services/jobAuthority';
import { PublishAsAccessError } from '../services/publishAsAccount';
import { syncJobToClarityInBackground } from '../services/clarityJobsAdapter';

function jobNotFound(res: Response) {
  return res.status(404).json({ error: 'Not found', message: 'Job not found' });
}

/**
 * Best-effort, fire-and-forget resync for THIS job whose last Clarity sync
 * failed — never blocks the response.
 *
 * Takes the row (not `listFailedClaritySyncs`'s global "most recently failed"
 * batch, which `retryFailedClarityJobSyncs` wraps): that batch has no jobId
 * filter, so calling it here would resync whichever job failed most recently
 * ACROSS THE WHOLE SITE — almost never the one this request is actually
 * viewing — and leave this job's own failure unretried indefinitely.
 */
function retryIfSyncFailed(row: MentionJobRow): void {
  if (row.claritySyncStatus !== 'failed') return;
  syncJobToClarityInBackground(row);
}

class JobsController {
  /**
   * `GET /jobs` — global discovery. Clarity supplies the results; this route
   * only maps query params to `JobSearchRequest` and returns them unmodified.
   * No local commercial re-ranking — see issue #952 "Ranking contract".
   */
  async search(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const workplaceType = queryString(req.query.workplaceType);
      const employmentType = queryString(req.query.employmentType);
      // codeql[js/sensitive-get-query] Public job-search filter criteria for a
      // discovery GET endpoint (salary range on a LISTED position), not
      // authentication or account data — every rendered listing already shows it.
      const salaryMin = queryInt(req.query.salaryMin);
      // codeql[js/sensitive-get-query] Public job-search filter criteria, see above.
      const salaryMax = queryInt(req.query.salaryMax);
      // codeql[js/sensitive-get-query] Public job-search filter criteria, see above.
      const salaryCurrencyInput = queryString(req.query.salaryCurrency)?.trim().toUpperCase();
      // Clarity answers an unknown currency with `400 invalid_request`; saying
      // so here keeps a typo from reading as "search is unavailable" (502).
      if (salaryCurrencyInput && !isCurrencyCode(salaryCurrencyInput)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'salaryCurrency must be an ISO 4217 currency code (e.g. "EUR")',
          issues: [{ path: 'salaryCurrency', message: 'salaryCurrency must be an ISO 4217 currency code (e.g. "EUR")' }],
        });
      }
      const salaryCurrency = salaryCurrencyInput && isCurrencyCode(salaryCurrencyInput) ? salaryCurrencyInput : undefined;
      // codeql[js/sensitive-get-query] Public job-search filter (employer name
      // on a listed position), not personal or account data.
      const employer = queryString(req.query.employer);
      const client = await getClarityClient();
      const result = await client.jobs.search({
        query: queryString(req.query.q),
        locations: queryString(req.query.location) ? [queryString(req.query.location) as string] : undefined,
        workplaceTypes: workplaceType && (MENTION_JOB_WORKPLACE_TYPES as readonly string[]).includes(workplaceType)
          ? [workplaceType as (typeof MENTION_JOB_WORKPLACE_TYPES)[number]]
          : undefined,
        employmentTypes: employmentType && (MENTION_JOB_EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)
          ? [employmentType as (typeof MENTION_JOB_EMPLOYMENT_TYPES)[number]]
          : undefined,
        // `!== undefined`, never truthiness: `salaryMin=0` is a legitimate "no
        // floor" filter, and `0 || salaryMax` would treat that falsy-but-present
        // 0 as absent and drop the whole salary filter, currency included.
        salary: salaryMin !== undefined || salaryMax !== undefined
          ? { min: salaryMin, max: salaryMax, currency: salaryCurrency }
          : undefined,
        publishedAfter: queryString(req.query.publishedAfter),
        employers: employer ? [employer] : undefined,
        cursor: queryString(req.query.cursor),
        limit: Math.min(queryInt(req.query.limit) ?? 20, 50),
      });
      res.json(result);
    } catch (error) {
      logger.error('[Jobs] Error in search:', error);
      next(createError(502, 'Job search is temporarily unavailable'));
    }
  }

  /** `GET /jobs/mine` — self-guarded (401 unauthenticated): every Mention-owned job across every employer the caller operates. */
  async getMine(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const employerIds = await listOperatedJobEmployerIds(createUserScopedOxyServices(req));
      if (employerIds.length === 0) return res.json({ jobs: [] });

      const status = queryString(req.query.status) as MentionJobPosting['status'] | undefined;
      const limit = queryInt(req.query.limit);
      const perEmployer = await Promise.all(
        employerIds.map((employerOxyUserId) =>
          listJobsByEmployer(employerOxyUserId, { status, limit }),
        ),
      );
      const jobs = perEmployer
        .flat()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, Math.min(limit ?? 20, 100))
        .map(expireIfDue)
        .map(toMentionJobPosting);
      res.json({ jobs });
    } catch (error) {
      logger.error('[Jobs] Error in getMine:', error);
      next(createError(500, 'Error listing your jobs'));
    }
  }

  /**
   * `GET /jobs/organization/:employerOxyUserId` — the org Jobs tab. Published
   * jobs only for an anonymous or unauthorized caller; every status when the
   * caller has live authority over that employer (self-elevated, not a 401).
   */
  async getOrganizationJobs(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employerOxyUserId = req.params.employerOxyUserId as string;
      let isAuthorizedOperator = false;
      try {
        await assertCanManageJob({
          employerOxyUserId,
          callerId: req.user?.id,
          memberReader: createUserScopedOxyServices(req),
        });
        isAuthorizedOperator = true;
      } catch {
        isAuthorizedOperator = false;
      }

      const status = isAuthorizedOperator
        ? (queryString(req.query.status) as MentionJobPosting['status'] | undefined)
        : 'published';
      const rows = await listJobsByEmployer(employerOxyUserId, { status, limit: queryInt(req.query.limit) });
      const expired = rows.map(expireIfDue);
      const jobs = isAuthorizedOperator ? expired : expired.filter((row) => row.status === 'published');
      res.json({ jobs: jobs.map(toMentionJobPosting) });
    } catch (error) {
      logger.error('[Jobs] Error in getOrganizationJobs:', error);
      next(createError(500, 'Error listing organization jobs'));
    }
  }

  /**
   * `GET /jobs/:id` — the canonical public job page. Registered LAST in the
   * router so every literal route above resolves first (same discipline as
   * `publicPostsRouter`). Accepts either the row id or its slug. A `draft` job
   * is visible only to an authorized operator; every other status is public.
   */
  async getJob(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const idOrSlug = req.params.id as string;
      const found = (await getJobById(idOrSlug)) ?? (await getJobBySlug(idOrSlug));
      if (!found) return jobNotFound(res);
      const row = expireIfDue(found);

      if (row.status === 'draft') {
        try {
          await assertCanManageJob({
            employerOxyUserId: row.employerOxyUserId,
            callerId: req.user?.id,
            memberReader: createUserScopedOxyServices(req),
          });
        } catch (error) {
          if (error instanceof PublishAsAccessError) return jobNotFound(res);
          throw error;
        }
      }

      const job = toMentionJobPosting(row);
      retryIfSyncFailed(row);
      res.json({ job });
    } catch (error) {
      logger.error('[Jobs] Error in getJob:', error);
      next(createError(500, 'Error fetching job'));
    }
  }
}

export default new JobsController();
