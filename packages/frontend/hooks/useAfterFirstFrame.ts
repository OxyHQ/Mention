import { useEffect, useState } from 'react';

/**
 * False for a screen's first render, true from the next frame. What can wait
 * a frame (a post's replies, its reply prompt) mounts once the screen has
 * drawn what the reader opened, so that first frame is not held up by it.
 */
export function useAfterFirstFrame(): boolean {
  const [after, setAfter] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAfter(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return after;
}
