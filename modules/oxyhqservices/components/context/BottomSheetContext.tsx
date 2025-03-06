/**
 * Bottom Sheet Context
 * 
 * Context for managing bottom sheet visibility and content throughout the app.
 * 
 * Example usage:
 * ```tsx
 * function App() {
 *   return (
 *     <BottomSheetProvider>
 *       <YourAppContent />
 *       <BottomSheetContainer />
 *     </BottomSheetProvider>
 *   );
 * }
 * ```
 */

import React, { createContext, ReactNode, useState } from 'react';

export interface BottomSheetContextType {
  isOpen: boolean;
  content: ReactNode | null;
  openBottomSheet: (status: boolean) => void;
  setBottomSheetContent: (content: ReactNode) => void;
}

// Default values for the context
const defaultContext: BottomSheetContextType = {
  isOpen: false,
  content: null,
  openBottomSheet: () => {},
  setBottomSheetContent: () => {}
};

// Create context
export const BottomSheetContext = createContext<BottomSheetContextType>(defaultContext);

interface BottomSheetProviderProps {
  children: ReactNode;
}

export function BottomSheetProvider({ children }: BottomSheetProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<ReactNode | null>(null);

  const openBottomSheet = (status: boolean) => {
    setIsOpen(status);
  };

  const setBottomSheetContent = (content: ReactNode) => {
    setContent(content);
  };

  return (
    <BottomSheetContext.Provider
      value={{
        isOpen,
        content,
        openBottomSheet,
        setBottomSheetContent
      }}
    >
      {children}
    </BottomSheetContext.Provider>
  );
}