import { useState, useEffect, useCallback, useRef } from 'react';

const DEFERRED_FETCH_DELAY_MS = 500;

interface DeferredToggleOptions {
  /** Whether to skip fetching entirely (e.g., own profile). */
  skip: boolean;
  /** Fetch the current boolean status from the server. */
  fetchStatus: () => Promise<boolean>;
  /** Execute the "enable" action. */
  onEnable: () => Promise<void>;
  /** Execute the "disable" action. */
  onDisable: () => Promise<void>;
}

interface DeferredToggleReturn {
  active: boolean;
  loading: boolean;
  toggle: () => Promise<void>;
}

/**
 * Shared hook for deferred boolean toggles (poke, subscription, etc.).
 *
 * Defers the initial status fetch by 500ms so it doesn't block profile
 * render. If toggle() is called before the deferred fetch fires, it
 * fetches on-demand first and cancels the timer to prevent races.
 * Reads state from a ref to avoid stale-closure bugs.
 */
export function useDeferredToggle({
  skip,
  fetchStatus,
  onEnable,
  onDisable,
}: DeferredToggleOptions): DeferredToggleReturn {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skip) return;

    fetchedRef.current = false;
    let cancelled = false;

    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      try {
        const status = await fetchStatus();
        if (!cancelled) {
          setActive(status);
          fetchedRef.current = true;
        }
      } catch {
        // Silently ignore — non-critical data
      }
    }, DEFERRED_FETCH_DELAY_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [skip, fetchStatus]);

  const toggle = useCallback(async () => {
    if (skip || loading) return;

    // Cancel the deferred timer to prevent concurrent fetches
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // If we haven't fetched yet, fetch now and use the result directly
    if (!fetchedRef.current) {
      try {
        const status = await fetchStatus();
        setActive(status);
        activeRef.current = status;
        fetchedRef.current = true;
      } catch {
        // Continue with default state
      }
    }

    setLoading(true);
    const previousState = activeRef.current;
    setActive(!previousState);

    try {
      if (!previousState) {
        await onEnable();
      } else {
        await onDisable();
      }
    } catch (error) {
      setActive(previousState);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [skip, loading, fetchStatus, onEnable, onDisable]);

  return { active, loading, toggle };
}
