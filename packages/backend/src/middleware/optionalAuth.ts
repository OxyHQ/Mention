import { config } from '../config';
import { supervisedActionForRequest } from './supervisedAction';
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

    const authMiddleware = oxy.middleware.auth({
      expectedAudience: `oxy-service:${config.identity.serviceApplicationId}`,
      supervisedAction: supervisedActionForRequest(req),
    });
    return authMiddleware(req, res, (error?: unknown) => {
      if (error) return next(error);
      next();
    });
  };
}
