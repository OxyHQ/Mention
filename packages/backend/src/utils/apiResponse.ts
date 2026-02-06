import { Response } from 'express';

/**
 * Standard API response format.
 * Ensures consistent response shape across all endpoints.
 */
export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  pagination?: {
    nextCursor?: string;
    hasMore: boolean;
    totalCount?: number;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Send a success response with consistent format.
 */
export function sendSuccess<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({
    success: true,
    data,
  });
}

/**
 * Send a paginated success response.
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  pagination: { nextCursor?: string; hasMore: boolean; totalCount?: number },
  status = 200
): void {
  res.status(status).json({
    success: true,
    data,
    pagination,
  });
}

/**
 * Send an error response with consistent format.
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  status = 500
): void {
  res.status(status).json({
    success: false,
    error: { code, message },
  });
}

/**
 * Common error codes for use with sendError.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
