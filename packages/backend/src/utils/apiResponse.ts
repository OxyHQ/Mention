// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
