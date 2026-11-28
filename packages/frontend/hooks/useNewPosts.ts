import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import { createLogger } from '@oxy.so/core/logger';
import { feedService } from '@/services/feedService';
import { socketService } from '@/services/socketService';

const logger = createLogger('NewPosts');

/** The page a check reads; a head with this many unseen posts is reported as "or more". */
export const NEW_POSTS_PROBE_LIMIT = 20;
/** At most one check per feed in this window, however many posts are published. */
export const NEW_POSTS_MIN_INTERVAL_MS = 60_000;
/** Spreads the checks of the readers one publication reaches at the same instant. */
export const NEW_POSTS_JITTER_MS = 5_000;

interface TimedItem {
  id?: string;
  metadata?: { createdAt?: string };
}

const createdAtOf = (item: TimedItem): number => Date.parse(item.metadata?.createdAt ?? '') || 0;

/**
 * Posts that arrived in the Following timeline since the reader's page was read,
 * counted without touching that page: nothing moves until the reader asks.
 *
 * `feed:updated` is sent to every connection for every public post, so it says
 * only that something was published somewhere. It schedules a check — one read
 * of the feed's head, rate limited and jittered — and the check counts the posts
 * newer than the newest loaded one. Chronological feeds only: reading a ranked
 * feed's head marks its posts as seen.
 */
export function useNewPosts({
  enabled,
  feedKey,
  items,
}: {
  enabled: boolean;
  /** Identity of the feed on screen; a different one starts from nothing. */
  feedKey: string;
  items: readonly TimedItem[];
}): { count: number; overflow: boolean; dismiss: () => void } {
  const visible = useScreenVisible();
  const [found, setFound] = useState<{ feedKey: string; ids: readonly string[] } | null>(null);

  // Read by the timer, which outlives the render that armed it.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  /** When this feed was last read, by its own load or by a check. */
  const lastReadRef = useRef<{ feedKey: string; at: number } | null>(null);

  const active = enabled && visible;
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    const known = lastReadRef.current?.feedKey === feedKey;
    if (!known) lastReadRef.current = { feedKey, at: now };

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const check = async () => {
      timer = undefined;
      // A hidden tab or a backgrounded app waits for the next publication.
      if (disposed || AppState.currentState === 'background') return;
      lastReadRef.current = { feedKey, at: Date.now() };
      const loaded = itemsRef.current;
      // Nothing on screen yet: the feed's own load answers.
      if (loaded.length === 0) return;
      const newest = Math.max(...loaded.map(createdAtOf));
      const page = await feedService.getMtnFeed('following', {
        limit: NEW_POSTS_PROBE_LIMIT,
        signal: controller.signal,
      });
      if (disposed) return;
      const ids = (page.items ?? [])
        .filter((item) => createdAtOf(item) > newest)
        .map((item) => item.id);
      setFound({ feedKey, ids });
    };

    const schedule = () => {
      if (disposed || timer !== undefined) return;
      const since = Date.now() - (lastReadRef.current?.at ?? 0);
      const wait = Math.max(0, NEW_POSTS_MIN_INTERVAL_MS - since);
      timer = setTimeout(
        () => {
          check().catch((error: unknown) => {
            if (!disposed) logger.debug('Could not check for new posts', { error });
          });
        },
        wait + Math.random() * NEW_POSTS_JITTER_MS,
      );
    };

    // Back in front after a while (a tab switch, a return to the app): publications
    // sent meanwhile were not heard.
    if (known && now - (lastReadRef.current?.at ?? now) >= NEW_POSTS_MIN_INTERVAL_MS) schedule();

    const unsubscribe = socketService.subscribeToFeedUpdates('following', schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      unsubscribe();
    };
  }, [active, feedKey]);

  // Derived, so any other read that brings these posts in clears the count.
  const count = useMemo(() => {
    if (!enabled || found?.feedKey !== feedKey || found.ids.length === 0) return 0;
    const loadedIds = new Set(items.map((item) => item.id));
    return found.ids.filter((id) => !loadedIds.has(id)).length;
  }, [enabled, found, feedKey, items]);

  return {
    count,
    overflow: count >= NEW_POSTS_PROBE_LIMIT,
    dismiss: () => setFound(null),
  };
}
