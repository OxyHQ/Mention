// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { nextUnvisitedCursor } from '@oxy.so/utils/paging';

type JobPage = { nextCursor?: string };
type ApplicationPage = JobPage & { hasMore: boolean };
type PageParam = string | undefined;

export function getNextJobPage(
  page: JobPage,
  _pages: unknown[],
  _lastPageParam: PageParam,
  pageParams: PageParam[],
): PageParam {
  return nextUnvisitedCursor(page.nextCursor, pageParams);
}

export function getNextJobApplicationPage(
  page: ApplicationPage,
  _pages: unknown[],
  _lastPageParam: PageParam,
  pageParams: PageParam[],
): PageParam {
  return page.hasMore ? nextUnvisitedCursor(page.nextCursor, pageParams) : undefined;
}
