import { useCallback, useLayoutEffect, useRef } from 'react';
import type { NotificationIntent } from '@/types/notificationIntent';

export type OwnNotificationSurface = <Result>(
  intent: NotificationIntent,
  present: (signal: AbortSignal) => Promise<Result>,
) => Promise<Result | undefined>;

/** Owns each notification surface until it settles or its screen/session ends. */
export function useOwnedNotificationSurfaces(
  isCurrent: (intent: NotificationIntent) => boolean,
  subscribe: (listener: () => void) => () => void,
): OwnNotificationSurface {
  const pending = useRef(new Set<AbortController>());
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    const controllers = pending.current;
    return () => {
      mounted.current = false;
      for (const controller of controllers) controller.abort();
    };
  }, []);

  return useCallback(
    async <Result>(
      intent: NotificationIntent,
      present: (signal: AbortSignal) => Promise<Result>,
    ): Promise<Result | undefined> => {
      if (!mounted.current) return undefined;
      const controller = new AbortController();
      pending.current.add(controller);
      const abortIfStale = () => {
        if (!mounted.current || !isCurrent(intent)) controller.abort();
      };
      let unsubscribe = () => {};
      try {
        unsubscribe = subscribe(abortIfStale);
        abortIfStale();
        if (controller.signal.aborted) return undefined;
        return await present(controller.signal);
      } finally {
        unsubscribe();
        pending.current.delete(controller);
      }
    },
    [isCurrent, subscribe],
  );
}
