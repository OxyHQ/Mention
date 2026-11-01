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
