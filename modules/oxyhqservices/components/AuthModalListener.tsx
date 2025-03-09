/**
 * AuthModalListener Component
 * 
 * Listens for global auth events and shows the auth modal when needed.
 * This component should be included once at the app root level.
 */

import React, { useEffect, useContext } from 'react';
import { AuthBottomSheet } from './AuthBottomSheet';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { authEvents } from '../utils/authEvents';
import { AuthMode } from './AuthBottomSheet/types';

export function AuthModalListener() {
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

  useEffect(() => {
    // Listen for auth required events
    const handleAuthRequired = (initialMode: AuthMode = 'signin') => {
      setBottomSheetContent(
        <AuthBottomSheet
          initialMode={initialMode}
          showLogo={true}
        />
      );
      openBottomSheet(true);
    };

    // Subscribe to auth events
    authEvents.on('authRequired', handleAuthRequired);
    authEvents.on('signupRequired', () => handleAuthRequired('signup'));
    authEvents.on('sessionRequired', () => handleAuthRequired('session'));

    // Cleanup
    return () => {
      authEvents.off('authRequired', handleAuthRequired);
      authEvents.off('signupRequired');
      authEvents.off('sessionRequired');
    };
  }, [openBottomSheet, setBottomSheetContent]);

  return null;
}