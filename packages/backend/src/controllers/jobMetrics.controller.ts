/**
 * Job METRICS reads/writes (OxyHQ/Mention#952 Phase E). Both routes mount
 * under `publicApi` with `optionalAuth` (same convention as
 * `jobs.controller.ts`) — `POST /jobs/:id/metrics` must accept an anonymous
 * caller (a view is a view whether or not the viewer is signed in), and
 * `GET /jobs/:id/metrics` self-guards through `assertCanManageJob` rather than
 * requiring login at the router level.
 *
 * PRIVACY INVARIANT (issue #952): "no named-viewer trail." `summary` returns
 * only the aggregate `MentionJobMetricsSummary` — see
 * `db/jobs/jobMetricsRepository.ts`, which has no viewer-identifying column to
 * leak in the first place.
 *
 * Detached-handler discipline, same as every other controller in this slice:
 * neither method below calls the other, so neither needs `this.`.
 */

import { Response, NextFunction } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';
import { requireEmployerAuthority } from '../services/jobAuthority';
import { getJobById } from '../db/jobs/jobRepository';
import { getJobMetricsSummary, recordJobMetricEvent } from '../db/jobs/jobMetricsRepository';

/**
 * Restated as a local runtime array for zod, same reason
 * `jobApplications.controller.ts` restates Clarity's `JobReportReason`:
 * `MentionJobMetricEvent` (`@mention/shared-types`) is a TYPE, not a const
 * array, so there is nothing to import here.
 */
const METRIC_EVENTS = ['view', 'apply_start', 'external_apply_click', 'application_completed'] as const;

const recordEventSchema = z.object({
  event: z.enum(METRIC_EVENTS),
});

function validationError(res: Response, message: string) {
  return res.status(400).json({ error: 'Validation error', message });
}

function jobNotFound(res: Response) {
  return res.status(404).json({ error: 'Not found', message: 'Job not found' });
}

class JobMetricsController {
  /**
   * `POST /jobs/:id/metrics` — PUBLIC. No `req.user` check: an anonymous
   * page view is exactly the kind of event this counts, and gating it on
   * login would undercount every visitor who has not signed in.
   */
  async record(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const jobId = req.params.id as string;
      const job = await getJobById(jobId);
      if (!job) return jobNotFound(res);

      const parsed = recordEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
      }

      await recordJobMetricEvent(jobId, parsed.data.event);
      res.status(204).end();
    } catch (error) {
      logger.error('[JobMetrics] Error in record:', error);
      next(createError(500, 'Error recording job metric'));
    }
  }

  /**
   * `GET /jobs/:id/metrics` — employer-only. Self-guarded through
   * `assertCanManageJob` (401/403/503 from there) rather than a router-level
   * auth requirement, matching `jobs.controller.ts`'s `getOrganizationJobs`.
   */
  async summary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const jobId = req.params.id as string;
      const job = await getJobById(jobId);
      if (!job) return jobNotFound(res);

      if (!(await requireEmployerAuthority(job.employerOxyUserId, req, res))) return;

      const metrics = await getJobMetricsSummary(jobId);
      res.json({ metrics });
    } catch (error) {
      logger.error('[JobMetrics] Error in summary:', error);
      next(createError(500, 'Error fetching job metrics'));
    }
  }
}

export default new JobMetricsController();
