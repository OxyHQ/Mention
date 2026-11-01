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
  const pending = useRef(new Map<AbortController, NotificationIntent>());
  const mounted = useRef(false);
  const currentIntent = useRef(isCurrent);
  const currentSubscription = useRef(subscribe);
  useLayoutEffect(() => {
    mounted.current = true;
    const controllers = pending.current;
    return () => {
      mounted.current = false;
      for (const controller of controllers.keys()) controller.abort();
    };
  }, []);
  useLayoutEffect(() => {
    const subscriptionChanged = currentSubscription.current !== subscribe;
    currentIntent.current = isCurrent;
    currentSubscription.current = subscribe;
    for (const [controller, intent] of pending.current) {
      if (subscriptionChanged || !isCurrent(intent)) controller.abort();
    }
  }, [isCurrent, subscribe]);

  return useCallback(
    async <Result>(
      intent: NotificationIntent,
      present: (signal: AbortSignal) => Promise<Result>,
    ): Promise<Result | undefined> => {
      if (!mounted.current || currentSubscription.current !== subscribe) return undefined;
      const controller = new AbortController();
      pending.current.set(controller, intent);
      const abortIfStale = () => {
        if (
          !mounted.current ||
          currentSubscription.current !== subscribe ||
          !currentIntent.current(intent)
        )
          controller.abort();
      };
      let unsubscribe = () => {};
      try {
        unsubscribe = subscribe(abortIfStale);
        abortIfStale();
        if (controller.signal.aborted) return undefined;
        const result = await present(controller.signal);
        return controller.signal.aborted || !mounted.current || !currentIntent.current(intent)
          ? undefined
          : result;
      } finally {
        // A surface can resolve before its exit animation unmounts. Hide any
        // remaining owner-bound content as soon as its result is settled.
        controller.abort();
        unsubscribe();
        pending.current.delete(controller);
      }
    },
    [subscribe],
  );
}
