/**
 * Feed Module Catalog Controller
 *
 * GET `/feed/modules` — the read-only catalog of modules the custom-feed builder
 * may compose (userComposable sources/filters + all ranking signals), grouped by
 * kind with i18n label/description keys and a params JSON-schema per module.
 * Derived from the live module registry so it can never drift from what
 * `validateDefinition` accepts.
 */

import { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { buildModuleCatalog } from '../feed/moduleCatalog';
import { sendErrorResponse, sendSuccessResponse } from '../../utils/apiHelpers';
import { logger } from '../../utils/logger';

class FeedModulesController {
  /** GET /feed/modules — the builder module catalog (read-only). */
  async list(_req: AuthRequest, res: Response): Promise<Response> {
    try {
      return sendSuccessResponse(res, 200, buildModuleCatalog());
    } catch (error) {
      logger.error('[FeedModules] Failed to build module catalog', { error });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to load feed modules');
    }
  }
}

export const feedModulesController = new FeedModulesController();
