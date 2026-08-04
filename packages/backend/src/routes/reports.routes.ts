import { Router, Response } from 'express';
import type { ModerationReportReceipt } from '@mention/shared-types';
import {
  REPORTED_TYPES,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
} from '../db/schema/moderation';
import {
  findReporterReports,
  type ReportRecord,
  type ReportStatus,
  type ReportedType,
} from '../db/moderation/reportRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  DuplicateReportError,
  createReport,
} from '../services/moderation/ReportIntakeService';
import { viewerOperatesAccount } from '../services/operatedAccountAccess';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { queryInt } from '../utils/queryParams';

const router = Router();

/** Report list page size (`GET /reports`). */
const DEFAULT_REPORTS_PAGE_SIZE = 20;
const MAX_REPORTS_PAGE_SIZE = 100;

/**
 * What a reporter is allowed to see about their own report.
 *
 * A projection, not the document. The row also carries the CrowdSource case id,
 * the decision id and its revision, and none of that belongs to the reporter:
 * §9.1 keeps a case away from everyone who is not on its jury, and the case id is
 * the value that makes one addressable. `decisionOutcome` is safe, and is the only
 * part of the answer the reporter actually asked for.
 */
function toReceipt(report: ReportRecord): ModerationReportReceipt {
  return {
    id: report.id,
    reportedType: report.reportedType,
    reportedId: report.reportedId,
    categories: report.categories,
    ...(report.details === undefined ? {} : { details: report.details }),
    status: report.status,
    localStatus: report.localStatus,
    ...(report.decisionOutcome === undefined
      ? {}
      : { decisionOutcome: report.decisionOutcome }),
    ...(report.enforcedAction === undefined
      ? {}
      : { enforcedAction: report.enforcedAction }),
    ...(report.enforcedAt === undefined
      ? {}
      : { enforcedAt: report.enforcedAt.toISOString() }),
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

/**
 * Create a report
 * POST /api/reports
 *
 * 201 means the report was stored — together with its durable delivery event, when
 * the reported type has one (§7.1). It never means CrowdSource accepted anything: no
 * outbound request is made here, and the reporter is not made to wait for a third
 * party to be reachable.
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const reporter = req.user?.id;
    const { reportedType, reportedId, categories, details } = req.body;

    if (!reporter) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Validate required fields
    if (!reportedType || !reportedId || !categories) {
      return res.status(400).json({
        message: 'reportedType, reportedId, and categories are required'
      });
    }

    /**
     * The stored enum is the API contract — NOT the subject registry.
     *
     * A type the registry has no provider for is accepted and stored locally; only a
     * type this application has no concept of at all is refused. Gating here on the
     * registry instead was tried and reverted: it turns adopting CrowdSource into a
     * breaking change for every report surface not yet wired to it, which is exactly
     * what has to not happen for the next six Oxy apps to adopt this one subject type
     * at a time. Whether a report went for review is answered by `localStatus` on the
     * receipt below, not by a refusal.
     */
    if (!(REPORTED_TYPES as readonly string[]).includes(reportedType)) {
      return res.status(400).json({
        message: `Invalid reportedType. Must be one of: ${REPORTED_TYPES.join(', ')}`
      });
    }

    // Validate categories
    if (!Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({
        message: 'categories must be a non-empty array'
      });
    }

    const invalidCategories = categories.filter(
      (cat: unknown) => !(REPORT_CATEGORIES as readonly unknown[]).includes(cat)
    );
    if (invalidCategories.length > 0) {
      return res.status(400).json({
        message: `Invalid categories: ${invalidCategories.join(', ')}. Must be one of: ${REPORT_CATEGORIES.join(', ')}`
      });
    }

    // Validate details length if provided
    if (details && typeof details === 'string' && details.length > 500) {
      return res.status(400).json({
        message: 'details must be 500 characters or less'
      });
    }

    /**
     * You cannot report an account you OPERATE — yourself, or a channel /
     * organization / project / bot you speak as.
     *
     * A report is an accusation laid before a jury by somebody who was not party
     * to the material. Filed against your own account it is not a moderation
     * request at all: it opens a CrowdSource case, draws real reviewers onto it,
     * and asks them to rule on whether you should be enforced against for what
     * you published. There is no state of the world in which that is the thing the
     * reporter meant, so it is refused rather than filed — the affordance is also
     * absent from the UI, but that is a consequence of it being meaningless, not
     * the thing that prevents it.
     *
     * **400, not 403.** An operator has MORE authority over this account than a
     * stranger does, so "forbidden" states the opposite of what is true: nothing
     * is being withheld from them. The target is simply not a valid target for
     * this verb. It also matches what the two neighbouring self-refusals already
     * answer — `POST /mute` for muting yourself, and Oxy's own
     * `POST /privacy/blocked/:id` for blocking yourself — so the same mistake gets
     * the same status wherever a client makes it.
     *
     * Only `user` reports ask this. The other reported types name objects, not
     * accounts, and the analogous rule for a POST is a different question with a
     * different answer already (`postManagementAccess`).
     */
    // The literal, because `ReportedType` is a union of `REPORTED_TYPES`, not an
    // enum — there is no `.USER` member to reach for, and the union is what makes
    // a typo here a compile error rather than a branch that never runs.
    if (reportedType === 'user') {
      const operatesTarget = await viewerOperatesAccount({
        targetOxyUserId: reportedId,
        callerId: reporter,
        memberReader: createUserScopedOxyServices(req),
      });
      if (operatesTarget) {
        return res.status(400).json({
          message: 'You cannot report an account you operate',
        });
      }
    }

    const { report, outboxEventId } = await createReport({
      reporter,
      reportedType,
      reportedId,
      categories,
      details: typeof details === 'string' && details.length > 0 ? details : undefined,
    });

    logger.info('Report created', {
      type: reportedType,
      categoryCount: categories.length,
      localStatus: report.localStatus,
      queued: outboxEventId !== undefined,
    });

    res.status(201).json({
      message: 'Report submitted successfully',
      report: toReceipt(report),
    });
  } catch (error) {
    if (error instanceof DuplicateReportError) {
      return res.status(409).json({
        message: 'You have already reported this item',
        report: toReceipt(error.existing),
      });
    }
    logger.error('Error creating report:', { userId: req.user?.id, reportedType: req.body.reportedType, reportedId: req.body.reportedId, error });
    res.status(500).json({
      message: 'Error creating report',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get reports
 * GET /api/reports
 *
 * The reporter's own reports, as receipts — never another reporter's, and never
 * the case behind one.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { status, reportedType, cursor } = req.query;

    /**
     * The two filters are ignored when the value is not one this deployment
     * knows — the same tolerance the previous implementation had, and the right
     * one for a query string.
     */
    const statusFilter =
      typeof status === 'string' && (REPORT_STATUSES as readonly string[]).includes(status)
        ? (status as ReportStatus)
        : undefined;
    const typeFilter =
      typeof reportedType === 'string'
        && (REPORTED_TYPES as readonly string[]).includes(reportedType)
        ? (reportedType as ReportedType)
        : undefined;

    const limitNum = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_REPORTS_PAGE_SIZE, 1), MAX_REPORTS_PAGE_SIZE);

    /**
     * The cursor is opaque and the keyset names the SAME pair the sort does.
     *
     * What this replaces was two different axes — sort by `createdAt`, page on
     * `_id` — gated on `mongoose.Types.ObjectId.isValid`, whose FALSE branch
     * means "no cursor", i.e. serve page one. Every id minted after the cutover
     * is a uuid v7, so that guard answered false for all of them and the list
     * would have handed back the first page forever with no error. A cursor
     * naming no row now simply matches nothing.
     */
    const page = await findReporterReports({
      reporter: userId,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(typeFilter ? { reportedType: typeFilter } : {}),
      ...(typeof cursor === 'string' && cursor.length > 0 ? { cursor } : {}),
      limit: limitNum,
    });

    const { hasMore, nextCursor } = page;

    res.json({
      reports: page.reports.map(toReceipt),
      hasMore,
      nextCursor
    });
  } catch (error) {
    logger.error('Error fetching reports:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({
      message: 'Error fetching reports',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
