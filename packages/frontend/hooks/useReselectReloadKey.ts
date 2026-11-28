import { type ScreenReselectHandler, useScreenReselectHandler } from '@oxy.so/bloom/screen';
import { useState } from 'react';

/**
 * For a screen whose reload is "fetch the feed again from the top": a
 * `reloadKey` for its `<Feed>` that moves each time the enclosing Screen is
 * reselected at the top. `refresh` carries whatever else reloads alongside
 * the feed. Call it from inside the `<Screen>`.
 */
export function useReselectReloadKey(refresh?: ScreenReselectHandler['refresh']): number {
  const [reloadKey, setReloadKey] = useState(0);
  useScreenReselectHandler({
    refresh: () => {
      setReloadKey((key) => key + 1);
      return refresh?.();
    },
  });
  return reloadKey;
}
