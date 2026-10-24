import { NotificationSkeleton } from '@/components/notifications/NotificationSkeleton';
import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import { VirtualList } from '@oxy.so/bloom/list';
import type React from 'react';
import { View } from 'react-native';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import type { NotificationListItem } from '@/utils/groupNotifications';

export interface NotificationsListProps {
  items: NotificationListItem[];
  renderRow: (item: NotificationListItem) => React.ReactElement;
  header: React.ReactElement | null;
  emptyState: React.ReactElement;
  tabKey: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** Fired when the list nears its end and another page can be loaded. */
  onEndReached?: () => void;
  /** Gates the load-more trigger — no next page ⇒ no trigger. */
  hasMore?: boolean;
  /** True while the next page is in flight (renders a footer skeleton). */
  isFetchingMore?: boolean;
}

// First-paint size guess before a row is measured. Single-actor rows land around
// ~71px and grouped rows (avatar strip + "Show all" + preview) around ~158px, so
// the mix skews toward the single row. The estimate is biased slightly ABOVE the
// common single-row height: an estimate under a grouped row's real height would
// position the next row against the shorter guess and overlap it for a frame,
// whereas a slightly-high guess only yields a transient gap that measurement
// closes. The list replaces it with the real height as each row mounts and as
// its grouped content settles.
const ESTIMATED_ROW_HEIGHT = 96;
const OVERSCAN_ROWS = 8;

const notificationKey = (item: NotificationListItem) => item.key;

/**
 * WEB notifications list: Bloom's `VirtualList`, windowed against the Screen's
 * scroller, so the body scrolls from anywhere (no inner overflow region, no
 * wheel bridge) and only the rows in the virtual window are mounted (bounded
 * DOM). Window-offset scroll restoration is keyed per active tab.
 */
export function NotificationsList({
  items,
  renderRow,
  header,
  emptyState,
  tabKey,
  onEndReached,
  hasMore,
  isFetchingMore,
}: NotificationsListProps) {
  const panel = usePanelScrollContainer<HTMLElement>();
  useScrollRestoration('window', { enabled: !panel, key: `notifications-${tabKey}` });

  return (
    <VirtualList
      data={items}
      keyExtractor={notificationKey}
      renderItem={({ item }) => renderRow(item)}
      estimatedItemSize={ESTIMATED_ROW_HEIGHT}
      overscan={OVERSCAN_ROWS}
      onEndReached={hasMore ? onEndReached : undefined}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={header}
      ListEmptyComponent={emptyState}
      ListFooterComponent={
        isFetchingMore ? (
          <View style={{ paddingVertical: 16, alignItems: 'center' }}>
            <NotificationSkeleton count={2} />
          </View>
        ) : null
      }
    />
  );
}
