/**
 * AuthModalListener Component
 * 
 * This component listens for authentication events and displays the auth sheet when needed.
 * It doesn't render any UI elements but provides automatic auth flow handling.
 */

import React, { useContext, useEffect, useCallback } from 'react';
import { addAuthEventListener, removeAuthEventListener } from '../utils/api';
import { BottomSheetContext } from './context/BottomSheetContext';
import { AuthBottomSheet } from './AuthBottomSheet';

export interface AuthModalListenerProps {
  /** Optional callback when auth modal is shown */
  onAuthModalShow?: () => void;
}

export function AuthModalListener({ onAuthModalShow }: AuthModalListenerProps): null {
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
  
  // Create a stable callback for the auth event handler
  const showAuthModal = useCallback(() => {
    setBottomSheetContent(
      <AuthBottomSheet 
        initialMode="signin" 
        showLogo={true} 
      />
    );
    openBottomSheet(true);
    
    if (onAuthModalShow) {
      onAuthModalShow();
    }
  }, [openBottomSheet, setBottomSheetContent, onAuthModalShow]);
  
  useEffect(() => {
    // Add listener when component mounts
    addAuthEventListener(showAuthModal);
    
    // Remove listener when component unmounts
    return () => {
      removeAuthEventListener(showAuthModal);
    };
  }, [showAuthModal]);
  
  // This component doesn't render anything
  return null;
}