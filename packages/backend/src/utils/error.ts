import { Request, Response, NextFunction } from 'express';
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
    code?: string
): Response {
    return res.status(status).json({
        success: false,
        error: {
            message,
            code: code || 'INTERNAL_ERROR'
        }
    });
}

/**
 * Extract a safe, user-facing message from an error.
 * Never exposes stack traces, file paths, or internal details.
 */
export function getSafeErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiError) {
        return error.message;
    }
    // For known Mongoose validation errors, provide a meaningful message
    if (error instanceof Error && error.name === 'ValidationError') {
        return 'Validation failed';
    }
    return fallback;
}

/**
 * Global error handler middleware — must be registered LAST in the Express middleware chain.
 * Catches unhandled errors from route handlers and sends a safe response.
 */
export function globalErrorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
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