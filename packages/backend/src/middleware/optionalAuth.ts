// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { createOxySessionAuth } from './oxySessionAuth';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OxyAuthRequest as AuthRequest, OxyServer } from '@oxy.so/core/server';
import { bearerLooksLikeMcpToken } from '../mcp/middleware/mcpAuth';
import { logger } from '../utils/logger';

/**
 * Best-effort Oxy authentication for public read routes.
 *
 * MCP bearer tokens are resolved by the preceding MCP middleware. A supplied
 * session must be verified; an outage cannot turn a supervised reader anonymous.
 */
export function createOptionalAuth(oxy: OxyServer): RequestHandler {
  const sessionAuth = createOxySessionAuth(oxy);
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req as AuthRequest).user?.id) {
      return next();
    }

    if (!req.headers.authorization) {
      logger.debug('Optional auth: No authorization header, continuing as unauthenticated');
      return next();
    }

    if (bearerLooksLikeMcpToken(req)) {
      return next();
    }

    return sessionAuth(req, res, next);
  };
}
