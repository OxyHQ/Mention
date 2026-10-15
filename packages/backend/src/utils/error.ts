import { STATUS_CODES } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

export class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || 'INTERNAL_ERROR';
    this.name = 'ApiError';
  }
}

export const createError = (statusCode: number, message: string, code?: string) => {
  return new ApiError(statusCode, message, code);
};

/**
 * Send a standardized error response to the client.
 * Never sends raw error objects, stack traces, or internal details.
 */
export function errorResponse(
  res: Response,
  status: number,
  message: string,
  code?: string,
): Response {
  return res.status(status).json({
    success: false,
    error: {
      message,
      code: code || 'INTERNAL_ERROR',
    },
  });
}

/**
 * An `http-errors` error the client caused: body-parser's (`raw-body`'s)
 * `entity.too.large` (413), `entity.parse.failed` (400), `request.size.invalid`
 * (400), `charset.unsupported` (415), `request.aborted` (400), and the like.
 * `http-errors` marks every status below 500 `expose`, which is how Express's
 * own final handler tells these from a server fault that merely carries a status.
 */
interface ClientRequestError extends Error {
  status: number;
  expose: true;
  type?: string;
}

function isClientRequestError(err: Error): err is ClientRequestError {
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return (
    expose === true &&
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  );
}

/**
 * Global error handler middleware — must be registered LAST in the Express middleware chain.
 * Catches unhandled errors from route handlers and sends a safe response.
 */
export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (isClientRequestError(err)) {
    // The client hung up while its body was still arriving. Nothing failed on
    // this side, and the socket a response would go to is already closed.
    if (err.type === 'request.aborted') {
      logger.debug('Client aborted the request before its body was read', {
        method: req.method,
        path: req.path,
      });
      return;
    }

    // A body the client sent that cannot be read: answer with the status the
    // parser chose. The parser's message can quote the body back, so the
    // client gets the status's standard text instead.
    logger.info('Rejected an unreadable request body', {
      method: req.method,
      path: req.path,
      status: err.status,
      type: err.type,
    });
    if (res.headersSent) {
      _next(err);
      return;
    }
    const reason = STATUS_CODES[err.status] ?? 'Bad Request';
    errorResponse(res, err.status, reason, reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
    return;
  }

  // Log the full error internally for debugging
  logger.error('Unhandled error in request handler', {
    method: req.method,
    path: req.path,
    error: err.message,
    stack: err.stack,
  });

  // If the response headers have already been sent, delegate to Express default handler
  if (res.headersSent) {
    _next(err);
    return;
  }

  if (err instanceof ApiError) {
    errorResponse(res, err.statusCode, err.message, err.code);
    return;
  }

  // Generic 500 — never expose internal error details
  errorResponse(res, 500, 'Internal server error', 'INTERNAL_ERROR');
}
