import React, { createContext, useContext, useRef, useCallback } from 'react';

interface HomeRefreshContextType {
  triggerHomeRefresh: () => void;
  registerHomeRefreshHandler: (handler: () => void) => void;
  unregisterHomeRefreshHandler: () => void;
}

const HomeRefreshContext = createContext<HomeRefreshContextType | null>(null);

export const HomeRefreshProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const handlerRef = useRef<(() => void) | null>(null);

  const triggerHomeRefresh = useCallback(() => {
    if (handlerRef.current) {
      handlerRef.current();
    }
  }, []);

  const registerHomeRefreshHandler = useCallback((handler: () => void) => {
    handlerRef.current = handler;
  }, []);

  const unregisterHomeRefreshHandler = useCallback(() => {
    handlerRef.current = null;
  }, []);

  return (
    <HomeRefreshContext.Provider value={{ triggerHomeRefresh, registerHomeRefreshHandler, unregisterHomeRefreshHandler }}>
      {children}
    </HomeRefreshContext.Provider>
  );
};

export const useHomeRefresh = () => {
  const context = useContext(HomeRefreshContext);
  if (!context) {
    throw new Error('useHomeRefresh must be used within HomeRefreshProvider');
  }
  return context;
};
