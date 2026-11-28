// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { nextUnvisitedCursor } from '@oxy.so/utils/paging';

export function getNextNotificationPage(
  page: { hasMore: boolean; nextCursor?: string },
  _pages: unknown[],
  _lastPageParam: string | undefined,
  pageParams: (string | undefined)[],
): string | undefined {
  return page.hasMore ? nextUnvisitedCursor(page.nextCursor, pageParams) : undefined;
}
