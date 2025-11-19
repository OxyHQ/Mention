import React, { useEffect, useState, memo } from 'react';
import { Platform } from 'react-native';
import { useOxy } from '@oxyhq/services';
import WelcomeModal from './WelcomeModal';

interface WelcomeModalGateProps {
  appIsReady: boolean;
}

/**
 * WelcomeModalGate Component
 * Manages when to show the welcome modal
 * - Only on web platform
 * - Only when app is ready
 * - Only if user is not authenticated
 */
const WelcomeModalGate: React.FC<WelcomeModalGateProps> = memo(({ appIsReady }) => {
  const { isAuthenticated } = useOxy();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    // Only show modal on web, when app is ready, and user is not authenticated
    if (Platform.OS === 'web' && appIsReady && !isAuthenticated) {
      // Small delay to ensure smooth transition from splash screen
      const timer = setTimeout(() => {
        setShowModal(true);
      }, 300);
      return () => clearTimeout(timer);
    } else {
      setShowModal(false);
    }
  }, [appIsReady, isAuthenticated]);

  const handleClose = () => {
    setShowModal(false);
  };

  return <WelcomeModal visible={showModal} onClose={handleClose} />;
});

WelcomeModalGate.displayName = 'WelcomeModalGate';

export default WelcomeModalGate;



