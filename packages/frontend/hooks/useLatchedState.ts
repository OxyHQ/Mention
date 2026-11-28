import { useCallback, useRef, useState } from 'react';

/**
 * State whose newest value is ALSO readable synchronously — the instant it is
 * set, before React has re-rendered.
 *
 * This exists for one specific bug class. An event handler memoized on a piece
 * of state reads the value from the render that created it, and a text input's
 * submit is the classic victim: the keystroke that sets the state and the Enter
 * that submits it can arrive in the same batch, so the handler still holds the
 * PREVIOUS value and submits `ca` while the box reads `cat`. Bluesky shipped
 * exactly that bug in their search box and fixed it this way (`59a2d19c2`).
 * Widening a memo's dependencies cannot fix it — the handler the input is
 * holding was created before the last keystroke either way.
 *
 * `setValue` writes the ref FIRST and then the state, so `getLatest()` is
 * correct from the moment of the write no matter when React re-renders.
 *
 * Use `value` for anything RENDERED, so the UI stays a pure function of state,
 * and `getLatest()` only in handlers that ACT on the value. `getLatest` and
 * `setValue` are both stable, so a handler depending on them never needs to be
 * rebuilt on a keystroke.
 */
export function useLatchedState<T>(initialValue: T): [T, (next: T) => void, () => T] {
  const [value, setValue] = useState(initialValue);
  const latest = useRef(initialValue);

  const set = useCallback((next: T) => {
    latest.current = next;
    setValue(next);
  }, []);

  const getLatest = useCallback(() => latest.current, []);

  return [value, set, getLatest];
}
