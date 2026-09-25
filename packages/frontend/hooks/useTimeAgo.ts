import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';
import { formatTimeAgo } from '@/utils/dateUtils';

/**
 * ONE clock for every relative timestamp on screen.
 *
 * A post header computed its "25s" once, when it rendered, and never again — so
 * a minute later it still said "25s" (OxyHQ/Mention#1140). The fix is not a timer
 * per row: a feed mounts dozens of headers and recycles them, and a timer each is
 * dozens of wake-ups and dozens of re-renders a tick. Instead one interval runs
 * while at least one label is mounted, and each label re-derives its own string
 * on the tick through `useSyncExternalStore` — which re-renders a row only when
 * its string actually CHANGED. "3h" stays "3h" for an hour and costs nothing but
 * a string comparison per tick.
 *
 * Every {@link TICK_MS}, plus once on the way back to the foreground, where an
 * app left in the background for an hour must not show the hour-old labels
 * until the next tick.
 */
export const TICK_MS = 15_000;

const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;
let appStateSubscription: NativeEventSubscription | null = null;

function tick(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) {
        interval = setInterval(tick, TICK_MS);
        // A label clock must never be what keeps a process alive (Node: static
        // rendering, jest). `unref` exists only on Node's timer object.
        (interval as { unref?: () => void }).unref?.();
        appStateSubscription = AppState.addEventListener?.('change', (state) => {
            if (state === 'active') tick();
        }) ?? null;
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            if (interval !== null) clearInterval(interval);
            interval = null;
            appStateSubscription?.remove();
            appStateSubscription = null;
        }
    };
}

/**
 * `formatTimeAgo(date)`, kept current. One hook slot, like the `useMemo` it
 * replaces: the snapshot is recomputed each render and on each tick, and React
 * bails out when it is the same string.
 */
export function useTimeAgo(date: number | string | Date | null | undefined): string {
    const read = () => formatTimeAgo(date || '');
    return useSyncExternalStore(subscribe, read, read);
}

/** How many labels the clock is serving. For tests. */
export function timeAgoSubscriberCount(): number {
    return listeners.size;
}
