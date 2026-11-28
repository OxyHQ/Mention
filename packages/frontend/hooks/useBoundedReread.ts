import { useEffect, useRef } from 'react';

/**
 * Read a feed's first page again on a bounded backoff while it holds something
 * the server will answer differently later (`reason`): a federated profile still
 * syncing, or an author Oxy could not resolve.
 *
 * `stamp` changes with every answer (React Query's `dataUpdatedAt`, the store's
 * `lastUpdated`), which arms the next read; a different `feedKey` or `reason`
 * starts again with the whole budget. `reason` undefined means nothing to wait
 * for. The feed owns what a read does, so `reload` is its own.
 */
export function useBoundedReread<Reason extends string>({
  feedKey,
  reason,
  delays,
  stamp,
  reload,
  onExhausted,
}: {
  feedKey: unknown;
  reason: Reason | undefined;
  delays: Readonly<Record<Reason, readonly number[]>>;
  stamp: number;
  reload: () => void;
  onExhausted: (reason: Reason) => void;
}): void {
  // The latest callbacks, read when the timer fires, so a new closure each
  // render never restarts the wait. Written after commit, not during render.
  const latest = useRef({ reload, onExhausted });
  useEffect(() => {
    latest.current = { reload, onExhausted };
  }, [reload, onExhausted]);

  const rereads = useRef({ feedKey, reason, count: 0 });
  useEffect(() => {
    if (rereads.current.feedKey !== feedKey || rereads.current.reason !== reason) {
      rereads.current = { feedKey, reason, count: 0 };
    }
    if (!reason) return;
    const polls = rereads.current;
    const delay = delays[reason][polls.count];
    if (delay === undefined) {
      latest.current.onExhausted(reason);
      return;
    }
    const timer = setTimeout(() => {
      polls.count += 1;
      latest.current.reload();
    }, delay);
    return () => clearTimeout(timer);
  }, [feedKey, reason, stamp, delays]);
}
