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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    const generation = ++generationRef.current;
    fetchedRef.current = false;
    pendingRef.current = false;
    setActive(false);
    setLoading(false);
    if (skip) return;
    let cancelled = false;

    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      try {
        const status = await fetchStatus();
        if (!cancelled && generation === generationRef.current && !pendingRef.current) {
          setActive(status);
          fetchedRef.current = true;
        }
      } catch {
        // Silently ignore — non-critical data
      }
    }, DEFERRED_FETCH_DELAY_MS);

    return () => {
      cancelled = true;
      generationRef.current += 1;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [skip, fetchStatus]);

  const toggle = useCallback(async () => {
    if (skip || pendingRef.current) return;
    // Invalidate any deferred read already in flight before this press.
    const generation = ++generationRef.current;
    pendingRef.current = true;
    setLoading(true);

    // Cancel the deferred timer to prevent concurrent fetches
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Which way this press goes is read from `active` itself. It used to come
    // from a ref mirrored during render — illegal input for the React Compiler,
    // and a mirror that lagged would send every press down the SAME branch, so
    // the bell or the poke would latch on and never turn off again. `active` is
    // in the deps below, so the closure is the current one; the local shadows it
    // only for the on-demand fetch, whose result this press must act on before
    // any re-render has happened.
    let current = active;

    // If we haven't fetched yet, fetch now and use the result directly
    if (!fetchedRef.current) {
      try {
        const status = await fetchStatus();
        if (generation !== generationRef.current) return;
        setActive(status);
        current = status;
        fetchedRef.current = true;
      } catch {
        if (generation !== generationRef.current) return;
        // Continue with default state
      }
    }

    const previousState = current;
    setActive(!previousState);

    try {
      if (!previousState) {
        await onEnable();
      } else {
        await onDisable();
      }
    } catch (error) {
      if (generation === generationRef.current) setActive(previousState);
      throw error;
    } finally {
      if (generation === generationRef.current) {
        pendingRef.current = false;
        setLoading(false);
      }
    }
  }, [skip, active, fetchStatus, onEnable, onDisable]);

  return { active, loading, toggle };
}
