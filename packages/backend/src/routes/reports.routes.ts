import { Router, Response } from 'express';
import Report, { ReportedType, ReportCategory, ReportStatus } from '../models/Report.model';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Create a report
 * POST /api/reports
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

    // Validate reportedType
    if (!Object.values(ReportedType).includes(reportedType)) {
      return res.status(400).json({
        message: `Invalid reportedType. Must be one of: ${Object.values(ReportedType).join(', ')}`
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

    // Check if user already reported this item
    const existingReport = await Report.findOne({
      reporter,
      reportedId,
      reportedType
    });

    if (existingReport) {
      return res.status(409).json({
        message: 'You have already reported this item',
        report: existingReport
      });
    }

    // Create report
    const report = new Report({
      reportedType,
      reportedId,
      reporter,
      categories,
      details: details || undefined,
      status: ReportStatus.PENDING
    });

    await report.save();

    logger.info(`Report created: ${reportedType} ${reportedId} by ${reporter}`, {
      categories,
      reportId: report._id
    });

    res.status(201).json({
      message: 'Report submitted successfully',
      report
    });
  } catch (error) {
    logger.error('Error creating report:', error);
    res.status(500).json({
      message: 'Error creating report',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get reports (admin endpoint - optional for now, can be expanded later)
 * GET /api/reports
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Optional: Add admin check here if needed
    // For now, return reports created by the current user
    const { status, reportedType, limit = '20', cursor } = req.query;

    const query: any = { reporter: userId };

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

    // Cursor-based pagination
    if (cursor && typeof cursor === 'string') {
      query._id = { $lt: cursor };
    }

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const reports = await Report.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    // Check if there are more results
    const hasMore = reports.length > limitNum;
    const reportsToReturn = hasMore ? reports.slice(0, limitNum) : reports;
    const nextCursor = hasMore && reportsToReturn.length > 0
      ? reportsToReturn[reportsToReturn.length - 1]._id.toString()
      : undefined;

    res.json({
      reports: reportsToReturn,
      hasMore,
      nextCursor
    });
  } catch (error) {
    logger.error('Error fetching reports:', error);
    res.status(500).json({
      message: 'Error fetching reports',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
