// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
