import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { AppColorName } from '@/lib/app-color-presets';

interface ScreenColorContextValue {
  /** The current screen's color preset name (e.g. from a visited profile) */
  screenColor: AppColorName | undefined;
  /** Screens call this to set their color (e.g. profile screen sets visited user's color) */
  setScreenColor: (color: AppColorName | undefined) => void;
}

const ScreenColorContext = createContext<ScreenColorContextValue>({
  screenColor: undefined,
  setScreenColor: () => {},
});

export function ScreenColorProvider({ children }: { children: React.ReactNode }) {
  const [screenColor, setScreenColorState] = useState<AppColorName | undefined>(undefined);

  const setScreenColor = useCallback((color: AppColorName | undefined) => {
    setScreenColorState((prev) => (prev === color ? prev : color));
  }, []);

  // Memoize the context value so consumers don't re-render unnecessarily.
  const value = useMemo<ScreenColorContextValue>(
    () => ({ screenColor, setScreenColor }),
    [screenColor, setScreenColor],
  );

  return (
    <ScreenColorContext.Provider value={value}>
      {children}
    </ScreenColorContext.Provider>
  );
}

export function useScreenColor() {
  return useContext(ScreenColorContext);
}
