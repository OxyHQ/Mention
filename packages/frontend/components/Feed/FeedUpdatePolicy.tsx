import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useScreenViewport, useScreenVisible } from '@oxy.so/bloom/screen';
import { socketService } from '@/services/socketService';
import type { FeedType } from '@mention/shared-types';

interface FeedUpdatePolicy {
  enabled: boolean;
  pauseWhileReading: boolean;
}
const FeedUpdatePolicyContext = createContext<FeedUpdatePolicy | null>(null);

/** Screen policy only: transport and feed fetching keep their existing owners. */
export function FeedUpdatePolicyProvider({
  children,
  ...policy
}: FeedUpdatePolicy & { children: ReactNode }) {
  return (
    <FeedUpdatePolicyContext.Provider value={policy}>{children}</FeedUpdatePolicyContext.Provider>
  );
}

export function useFeedLiveUpdates(
  type: FeedType,
  refresh: () => Promise<void>,
  authenticated: boolean,
) {
  const policy = useContext(FeedUpdatePolicyContext);
  const viewport = useScreenViewport();
  const visible = useScreenVisible();
  const enabled = policy?.enabled && authenticated;
  const pauseWhileReading = policy?.pauseWhileReading ?? true;
  // Updates arriving while the reader cannot see the screen wait for it to come
  // back; the subscription stays up so none are missed.
  const visibleRef = useRef(visible);
  const wakeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    visibleRef.current = visible;
    if (visible) wakeRef.current?.();
  }, [visible]);
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    let pending = false;
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      timer = undefined;
      if (disposed || running || !pending || !visibleRef.current) return;
      if (pauseWhileReading && (viewport?.metrics.scrollY.value ?? 0) > 1) return;
      pending = false;
      running = true;
      try {
        await refresh();
      } catch {
        /* The feed owns its retry/error presentation. */
      } finally {
        running = false;
        if (pending && !disposed) schedule();
      }
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(() => void flush(), 200);
    };
    wakeRef.current = schedule;
    // Production emits post invalidations for for_you and following.
    // Re-read the actual screen's feed through its authorized HTTP query.
    const unsubscribe = socketService.subscribeToFeedUpdates(
      type === 'following' ? 'following' : 'for_you',
      () => {
        pending = true;
        schedule();
      },
    );
    const owner =
      viewport?.kind === 'element' ? (viewport.scrollRef?.current as HTMLElement | null) : window;
    owner?.addEventListener('scroll', schedule, { passive: true });
    return () => {
      disposed = true;
      wakeRef.current = null;
      clearTimeout(timer);
      unsubscribe();
      owner?.removeEventListener('scroll', schedule);
    };
  }, [enabled, pauseWhileReading, type, refresh, viewport]);
}
