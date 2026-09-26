import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OxyAuthRequest as AuthRequest, OxyServer } from '@oxy.so/core/server';
import { bearerLooksLikeMcpToken } from '../mcp/middleware/mcpAuth';
import { logger } from '../utils/logger';

/**
 * Best-effort Oxy authentication for public read routes.
 *
 * MCP bearer tokens are resolved by the preceding MCP middleware and must not
 * be sent through Oxy authentication. Invalid Oxy sessions degrade to an
 * anonymous request without rejecting the public read.
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

    const authMiddleware = oxy.middleware.auth();
    return authMiddleware(req, res, (error?: unknown) => {
      if (error) {
        logger.debug(
          'Optional auth: authentication failed; continuing as unauthenticated',
          { error },
        );
        (req as AuthRequest).user = undefined;
      }
      next();
    });
  };
}
