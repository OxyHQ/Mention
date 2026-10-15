import { useCallback, useSyncExternalStore } from 'react';
import type { VisibleReferenceStore } from '@/lib/references/VisibleReferenceStore';

const subscribeNothing = () => () => {};

/** A hidden/render-ahead card neither subscribes nor schedules a provider request. */
export function useVisibleReference<T extends { id: string }>(
  store: VisibleReferenceStore<T>,
  id: string,
  visible: boolean,
) {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(id, listener),
    [store, id],
  );
  const snapshot = useCallback(() => store.getSnapshot(id), [store, id]);
  return useSyncExternalStore(visible ? subscribe : subscribeNothing, snapshot, snapshot);
}
