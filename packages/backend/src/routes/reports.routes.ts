import { Router, Response } from 'express';
import mongoose from 'mongoose';
import type { ModerationReportReceipt } from '@mention/shared-types';
import Report, {
  ReportedType,
  ReportCategory,
  ReportStatus,
  type LeanReport,
  type ReportFields,
} from '../models/Report.model';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  DuplicateReportError,
  createReport,
} from '../services/moderation/ReportIntakeService';
import {
  isReportableType,
  reportableTypes,
} from '../services/moderation/subjects/registry';
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
function toReceipt(report: ReportFields & { _id: unknown }): ModerationReportReceipt {
  return {
    id: String(report._id),
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
 * 201 means the report row and its durable delivery event committed together
 * (§7.1). It never means CrowdSource accepted anything — no outbound request is
 * made here, and the reporter is not made to wait for a third party to be
 * reachable.
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
     * Validate reportedType against what Mention can actually moderate, not merely
     * against the stored enum.
     *
     * The registry is the authority because the constraint is about OWNERSHIP, not
     * capability: `applicationId` comes off the credential, so a report Mention
     * submits opens a case in Mention's tenant — and a case about an object another
     * application owns cannot be enforced here and collides with that application's
     * own case for the same object. Refusing is the honest answer; accepting into a
     * terminal local state would tell the reporter their report was received while
     * nothing would ever read it again.
     */
    if (!isReportableType(reportedType)) {
      return res.status(400).json({
        message: `Invalid reportedType. Must be one of: ${reportableTypes().join(', ')}`
      });
    }

    // Validate categories
    if (!Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({
        message: 'categories must be a non-empty array'
      });
    }

    const invalidCategories = categories.filter(
      cat => !Object.values(ReportCategory).includes(cat)
    );
    if (invalidCategories.length > 0) {
      return res.status(400).json({
        message: `Invalid categories: ${invalidCategories.join(', ')}. Must be one of: ${Object.values(ReportCategory).join(', ')}`
      });
    }

    // Validate details length if provided
    if (details && typeof details === 'string' && details.length > 500) {
      return res.status(400).json({
        message: 'details must be 500 characters or less'
      });
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

    const query: mongoose.FilterQuery<LeanReport> = { reporter: userId };

    // Filter by status
    if (status && typeof status === 'string') {
      if (Object.values(ReportStatus).includes(status as ReportStatus)) {
        query.status = status;
      }
    }

    // Filter by reportedType
    if (reportedType && typeof reportedType === 'string') {
      if (Object.values(ReportedType).includes(reportedType as ReportedType)) {
        query.reportedType = reportedType;
      }
    }

    // Cursor-based pagination. Guard against a non-ObjectId cursor: casting a raw
    // client string that isn't a valid ObjectId throws a Mongoose CastError → 500.
    // An invalid cursor is ignored (returns the first page) rather than erroring.
    if (cursor && typeof cursor === 'string' && mongoose.Types.ObjectId.isValid(cursor)) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const limitNum = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_REPORTS_PAGE_SIZE, 1), MAX_REPORTS_PAGE_SIZE);

    const reports = await Report.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean<LeanReport[]>();

    // Check if there are more results
    const hasMore = reports.length > limitNum;
    const reportsToReturn = hasMore ? reports.slice(0, limitNum) : reports;
    const nextCursor = hasMore && reportsToReturn.length > 0
      ? String(reportsToReturn[reportsToReturn.length - 1]._id)
      : undefined;

    res.json({
      reports: reportsToReturn.map(toReceipt),
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
