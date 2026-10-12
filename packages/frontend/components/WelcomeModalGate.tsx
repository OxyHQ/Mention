import type React from 'react';
import { useEffect, useState, memo, Suspense, lazy } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

// Lazy load WelcomeModal - only loads when needed (web + unauthenticated + first time)
const WelcomeModal = lazy(() => import('./WelcomeModal'));

const WELCOME_MODAL_SEEN_KEY = 'welcome_modal_seen';

interface WelcomeModalGateProps {
  appIsReady: boolean;
}

/**
 * WelcomeModalGate Component
 * Manages when to show the welcome modal
 * - Only on web platform
 * - Only wider than a phone: on a phone it would cover the whole page the
 *   reader came for, which is the intrusive interstitial search engines rank
 *   down (Google indexes the phone layout). The sign-in banner covers phones.
 * - Only when app is ready
 * - Only if user is not authenticated
 * - Only if user hasn't seen it before (first time only)
 */
const WelcomeModalGate: React.FC<WelcomeModalGateProps> = memo(({ appIsReady }) => {
  const { isAuthenticated } = useAuth();
  const notPhone = useIsScreenNotMobile();
  const [showModal, setShowModal] = useState(false);
  // Once shown, the modal stays mounted so Bloom's Dialog can play its exit
  // animation when `visible` flips to false (it unmounts its own surface).
  const [hasShown, setHasShown] = useState(false);

  // Check if user has seen the modal before
  useEffect(() => {
    async function checkIfSeen() {
      try {
        const seen = await AsyncStorage.getItem(WELCOME_MODAL_SEEN_KEY);

        // Only show modal if: web + not a phone + app ready + not authenticated + hasn't seen before
        if (Platform.OS === 'web' && notPhone && appIsReady && !isAuthenticated && !seen) {
          // Small delay to ensure smooth transition from splash screen
          setTimeout(() => {
            setShowModal(true);
            setHasShown(true);
          }, 300);
        }
      } catch {
        logger.warn('Failed to check welcome modal status');
      }
    }

    if (appIsReady) {
      checkIfSeen();
    }
  }, [appIsReady, isAuthenticated, notPhone]);

  const handleClose = async () => {
    setShowModal(false);

    // Mark as seen when user closes or interacts with the modal
    try {
      await AsyncStorage.setItem(WELCOME_MODAL_SEEN_KEY, 'true');
    } catch {
      logger.warn('Failed to save welcome modal status');
    }
  };

  // Only render once the modal has been requested, to avoid loading the component unnecessarily
  if (!hasShown) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <WelcomeModal visible={showModal} onClose={handleClose} />
    </Suspense>
  );
});

WelcomeModalGate.displayName = 'WelcomeModalGate';

export default WelcomeModalGate;
