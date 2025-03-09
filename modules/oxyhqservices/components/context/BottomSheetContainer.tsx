/**
 * BottomSheetContainer Component
 * 
 * Container component that renders the bottom sheet modal.
 * This component should be rendered at the root of the app.
 * 
 * Example usage of the session switcher:
 * 
 * ```jsx
 * import { bottomSheetState } from '@/modules/oxyhqservices/components/context/BottomSheetContainer';
 * 
 * // In your component:
 * const handleOpenSessionSwitcher = () => {
 *   bottomSheetState.openSessionSwitcher();
 * };
 * 
 * // Then in your JSX:
 * <Button onPress={handleOpenSessionSwitcher} title="Switch Account" />
 * ```
 */

import React, { useContext, useState, useEffect, ReactNode } from 'react';
import { Modal, View, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { colors } from '../../styles/colors';
import { useSession } from '../../hooks/useSession';
import { useProfile } from '../../hooks/useProfile';
import { userService } from '../../services/user.service';
import { profileService } from '../../services/profile.service';
import { OxyProfile } from '../../types';
// Import SessionSwitcher directly to avoid dynamic imports
import { SessionSwitcher } from '../SessionSwitcher';

// Create a context for user data
export const UserDataContext = React.createContext<any>(null);

// Export a hook to access user data
export const useUserData = () => React.useContext(UserDataContext);

// Create a simple event emitter for bottom sheet state
export const bottomSheetState = {
  isOpen: false,
  content: null as ReactNode,
  listeners: [] as Array<() => void>,

  setOpen(open: boolean) {
    this.isOpen = open;
    this.notifyListeners();
  },

  setContent(content: ReactNode) {
    this.content = content;
    this.notifyListeners();
  },

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  },

  notifyListeners() {
    this.listeners.forEach(listener => listener());
  },

  // Helper function to open the session switcher
  openSessionSwitcher() {
    try {
      this.setContent(
        <SessionSwitcher
          onClose={() => {
            this.setOpen(false);
            this.setContent(null);
          }}
        />
      );
      this.setOpen(true);
    } catch (error) {
      console.error('Error opening session switcher:', error);
    }
  }
};

export function BottomSheetContainer() {
  const { openBottomSheet } = useContext(BottomSheetContext);
  const [isOpen, setIsOpen] = useState(bottomSheetState.isOpen);
  const [content, setContent] = useState<ReactNode>(bottomSheetState.content);

  // Get user session data
  const { state: sessionState, sessions: contextSessions, isAuthenticated } = useSession();
  const { getProfile } = useProfile();
  const [userData, setUserData] = useState<any>(null);
  const [sessions, setSessions] = useState<Array<{ id: string, profile?: OxyProfile }>>([]);

  // Load sessions data with profiles
  useEffect(() => {
    const loadSessionsWithProfiles = async () => {
      try {
        // Get sessions from the user service
        const { data: serviceSessions } = await userService.getSessions();

        // Load profile data for each session
        const sessionsWithProfiles = await Promise.all(
          serviceSessions.map(async (session) => {
            try {
              // If the session already has a profile, use it
              if (session.profile) {
                return session;
              }

              // Otherwise, fetch the profile
              const profile = await profileService.getProfileById(session.id);
              return {
                ...session,
                profile
              };
            } catch (error) {
              console.error(`Error loading profile for session ${session.id}:`, error);
              return session;
            }
          })
        );

        setSessions(sessionsWithProfiles);
      } catch (error) {
        console.error('Error loading sessions with profiles:', error);
      }
    };

    if (isAuthenticated) {
      loadSessionsWithProfiles();
    }
  }, [isAuthenticated]);

  // Load user data when the component mounts
  useEffect(() => {
    const loadUserData = async () => {
      if (isAuthenticated && sessionState.userId) {
        try {
          // Get the current user's profile
          const profile = await getProfile(sessionState.userId);
          if (profile) {
            setUserData({
              id: sessionState.userId,
              username: profile.username,
              name: profile.name,
              email: profile.email,
              avatar: profile.avatar,
              isAuthenticated: true,
              sessions: sessions // Include sessions in the user data
            });
          }
        } catch (error) {
          console.error('Error loading user data:', error);
        }
      } else {
        setUserData(null);
      }
    };

    loadUserData();
  }, [isAuthenticated, sessionState.userId, getProfile, sessions]);

  // Subscribe to bottom sheet state changes
  useEffect(() => {
    const unsubscribe = bottomSheetState.subscribe(() => {
      setIsOpen(bottomSheetState.isOpen);
      setContent(bottomSheetState.content);
    });

    return unsubscribe;
  }, []);

  const handleBackdropPress = () => {
    bottomSheetState.setOpen(false);
    openBottomSheet(false);
  };

  // Make user data available to the content
  const contentWithUserData = React.useMemo(() => {
    if (!content) return null;

    // Create a combined context value with user data and sessions
    const contextValue = {
      ...userData,
      sessions: sessions.length > 0 ? sessions : contextSessions
    };

    // Instead of cloning the element, we'll wrap it in a context provider
    return (
      <UserDataContext.Provider value={contextValue}>
        {content}
      </UserDataContext.Provider>
    );
  }, [content, userData, sessions, contextSessions]);

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="slide"
      onRequestClose={handleBackdropPress}
    >
      <TouchableWithoutFeedback onPress={handleBackdropPress}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.contentContainer}>
              {contentWithUserData}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  contentContainer: {
    backgroundColor: colors.primaryLight,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    maxHeight: '80%',
  },
});