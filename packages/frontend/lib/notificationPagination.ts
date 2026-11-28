import { nextUnvisitedCursor } from '@oxy.so/utils/paging';

export function getNextNotificationPage(
  page: { hasMore: boolean; nextCursor?: string },
  _pages: unknown[],
  _lastPageParam: string | undefined,
  pageParams: (string | undefined)[],
): string | undefined {
  return page.hasMore ? nextUnvisitedCursor(page.nextCursor, pageParams) : undefined;
}
