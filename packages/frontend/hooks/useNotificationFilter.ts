import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from '@/lib/navigation/router';

export type NotificationTab = 'all' | 'mentions' | 'follows' | 'likes' | 'posts' | 'pokes';

function isNotificationTab(value: unknown): value is NotificationTab {
  return (
    value === 'all' ||
    value === 'mentions' ||
    value === 'follows' ||
    value === 'likes' ||
    value === 'posts' ||
    value === 'pokes'
  );
}

/** Keep the filter with this inbox route when its screen unmounts behind a post. */
export function useNotificationFilter() {
  const { filter } = useLocalSearchParams<{ filter?: string | string[] }>();
  const router = useRouter();
  const activeTab: NotificationTab = isNotificationTab(filter) ? filter : 'all';
  const selectTab = useCallback(
    (tab: string) => {
      if (isNotificationTab(tab)) router.setParams({ filter: tab === 'all' ? undefined : tab });
    },
    [router],
  );
  return { activeTab, selectTab };
}
