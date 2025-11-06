import { Response } from 'express';

/**
 * Standard API error response format
 */
export interface ApiErrorResponse {
  error: string;
  message: string;
}

/**
 * Standard API success response format
 */
export interface ApiSuccessResponse<T = any> {
  success?: boolean;
  message?: string;
  data?: T;
}

/**
 * Sends standardized error response
 */
export function sendErrorResponse(
  res: Response,
  status: number,
  error: string,
  message: string
): Response {
  return res.status(status).json({ error, message });
}

/**
 * Sends standardized success response
 */
export function sendSuccessResponse<T>(
  res: Response,
  status: number,
  data: T,
  message?: string
): Response {
  const response: ApiSuccessResponse<T> = { data };
  if (message) response.message = message;
  if (status === 201) response.success = true;
  return res.status(status).json(response);
}

/**
 * Validates required parameter
 */
export function validateRequired(param: any, paramName: string): string | null {
  if (!param) {
    return `Missing ${paramName} parameter`;
  }
  return null;
}

