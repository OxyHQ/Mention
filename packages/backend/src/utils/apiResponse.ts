import type { Response } from 'express';

/**
 * Pagination metadata. Supports both cursor-based (`nextCursor`) and
 * offset-based (`offset` + `limit`, for infinite scroll) pagination; `hasMore`
 * is the single signal shared by both styles.
 */
export interface PaginationMeta {
  nextCursor?: string;
  hasMore: boolean;
  totalCount?: number;
  offset?: number;
  limit?: number;
}

/**
 * Send a paginated success response.
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  pagination: PaginationMeta,
  status = 200,
): void {
  res.status(status).json({
    success: true,
    data,
    pagination,
  });
}
