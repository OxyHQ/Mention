import React, { useEffect, useState, memo } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOxy } from '@oxyhq/services';
import WelcomeModal from './WelcomeModal';

const WELCOME_MODAL_SEEN_KEY = 'welcome_modal_seen';

interface WelcomeModalGateProps {
  appIsReady: boolean;
}

/**
 * WelcomeModalGate Component
 * Manages when to show the welcome modal
 * - Only on web platform
 * - Only when app is ready
 * - Only if user is not authenticated
 * - Only if user hasn't seen it before (first time only)
 */
const WelcomeModalGate: React.FC<WelcomeModalGateProps> = memo(({ appIsReady }) => {
  const { isAuthenticated } = useOxy();
  const [showModal, setShowModal] = useState(false);

  // Check if user has seen the modal before
  useEffect(() => {
    async function checkIfSeen() {
      try {
        const seen = await AsyncStorage.getItem(WELCOME_MODAL_SEEN_KEY);

        // Only show modal if: web + app ready + not authenticated + hasn't seen before
        if (Platform.OS === 'web' && appIsReady && !isAuthenticated && !seen) {
          // Small delay to ensure smooth transition from splash screen
          setTimeout(() => {
            setShowModal(true);
          }, 300);
        }
      } catch (error) {
        console.warn('Failed to check welcome modal status:', error);
      }
    }

    if (appIsReady) {
      checkIfSeen();
    }
  }, [appIsReady, isAuthenticated]);

  const handleClose = async () => {
    setShowModal(false);

    // Mark as seen when user closes or interacts with the modal
    try {
      await AsyncStorage.setItem(WELCOME_MODAL_SEEN_KEY, 'true');
    } catch (error) {
      console.warn('Failed to save welcome modal status:', error);
    }
  };

  return <WelcomeModal visible={showModal} onClose={handleClose} />;
});

WelcomeModalGate.displayName = 'WelcomeModalGate';

export default WelcomeModalGate;



