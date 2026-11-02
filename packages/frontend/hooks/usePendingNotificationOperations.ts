import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useMutationState } from '@tanstack/react-query';
import type { OxyServices } from '@oxy.so/core';
import type { NotificationOptimisticOperation } from '@/utils/notificationOptimism';

/** All notification writes share one mutation-cache family. */
export const NOTIFICATION_OPTIMISTIC_KEY = ['notification-optimistic'] as const;

/** Pending operations live in React Query's mutation cache, not in a second mutable store. */
export function usePendingNotificationOperations(
  viewerId: string | null | undefined,
  oxyServices: Pick<OxyServices, 'http' | 'session'>,
): { operations: readonly NotificationOptimisticOperation[]; epoch: number } {
  const subscribe = useCallback(
    (listener: () => void) => oxyServices.session.onChange(listener),
    [oxyServices],
  );
  const getEpoch = useCallback(() => oxyServices.http.getSessionEpoch(), [oxyServices]);
  const epoch = useSyncExternalStore(subscribe, getEpoch, getEpoch);
  const pending = useMutationState<NotificationOptimisticOperation | undefined>({
    filters: { mutationKey: NOTIFICATION_OPTIMISTIC_KEY, status: 'pending' },
    select: (mutation) => mutation.state.context as NotificationOptimisticOperation | undefined,
  });
  const operations = useMemo(
    () =>
      pending.filter(
        (operation): operation is NotificationOptimisticOperation =>
          !!operation && operation.viewerId === viewerId && operation.epoch === epoch,
      ),
    [pending, viewerId, epoch],
  );
  return { operations, epoch };
}
