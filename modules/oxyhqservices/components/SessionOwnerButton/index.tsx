import { colors } from '../../styles/colors';
import { Ionicons } from '@expo/vector-icons';
import React, { useContext, useEffect, useState, useCallback } from 'react';
import { View, Pressable, StyleSheet, Image, Text, ActivityIndicator } from 'react-native';
import { BottomSheetContext } from '../context/BottomSheetContext';
import { AuthBottomSheet } from '../AuthBottomSheet';
import { SessionContext } from '../SessionProvider';
import { profileService } from '../../services/profile.service';
import type { OxyProfile } from '../../types';
import { OxyLogo } from '../OxyLogo';
import errorHandler from '../../utils/errorHandler';
import { SessionSwitcher } from '../SessionSwitcher';

interface SessionOwnerButtonProps {
  collapsed?: boolean;
  onSessionChange?: () => void;
}

/**
 * SessionOwnerButton Component
 * 
 * A button that displays the current user's profile and allows switching between sessions.
 * If no user is logged in, it shows a sign-in button.
 * 
 * @param collapsed - Whether to show a collapsed version of the button (icon only)
 * @param onSessionChange - Optional callback when session changes
 */
export function SessionOwnerButton({
  collapsed = false,
  onSessionChange
}: SessionOwnerButtonProps) {
  const [currentProfile, setCurrentProfile] = useState<OxyProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
  const sessionContext = useContext(SessionContext);

  const isAuthenticated = sessionContext?.isAuthenticated || false;
  const userId = sessionContext?.getCurrentUserId();
  const sessions = sessionContext?.sessions || [];
  const hasMultipleSessions = sessions.length > 1;

  // Load the current user's profile
  const loadProfile = useCallback(async () => {
    if (!userId) {
      setCurrentProfile(null);
      return;
    }

    setLoading(true);
    try {
      const profile = await profileService.getProfileById(userId);
      setCurrentProfile(profile);
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'SessionOwnerButton',
        fallbackMessage: 'Failed to load profile',
        showToast: false
      });
      setCurrentProfile(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  // Handle button press - open auth modal or session switcher
  const handleButtonPress = useCallback(() => {
    // If not authenticated, show the auth bottom sheet
    if (!isAuthenticated) {
      setBottomSheetContent(
        <AuthBottomSheet
          initialMode="signin"
          showLogo={true}
        />
      );
    } else {
      // If authenticated, show the session switcher
      setBottomSheetContent(
        <SessionSwitcher
          onClose={() => openBottomSheet(false)}
        />
      );
    }

    // Open the bottom sheet
    openBottomSheet(true);

    // Call the onSessionChange callback if provided
    if (onSessionChange) {
      onSessionChange();
    }
  }, [isAuthenticated, setBottomSheetContent, openBottomSheet, onSessionChange]);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      marginBottom: 0,
      marginRight: !collapsed ? 20 : 0,
    },
    button: {
      flexDirection: 'row',
      padding: !collapsed ? 10 : 0,
      backgroundColor: colors.primaryLight,
      borderRadius: 35,
      width: !collapsed ? '100%' : 40,
      alignItems: 'center',
      justifyContent: collapsed ? 'center' : 'flex-start',
      borderWidth: 1,
      borderColor: colors.COLOR_BLACK,
    },
    avatar: {
      width: 35,
      height: 35,
      borderRadius: 35,
      marginRight: collapsed ? 0 : 8,
      borderWidth: 1,
      borderColor: colors.COLOR_BLACK_LIGHT_6,
      backgroundColor: colors.primaryLight,
    },
    name: {
      fontWeight: 'bold',
      color: colors.COLOR_BLACK,
    },
    username: {
      color: colors.COLOR_BLACK_LIGHT_4,
    },
    badge: {
      position: 'absolute',
      top: -5,
      right: -5,
      backgroundColor: colors.primaryColor,
      borderRadius: 10,
      width: 20,
      height: 20,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    badgeText: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: 'bold',
    },
    loadingContainer: {
      justifyContent: 'center',
      alignItems: 'center',
    }
  });

  // Show loading state
  if (loading) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="small" color={colors.primaryColor} />
      </View>
    );
  }

  // Not authenticated - show sign in button
  if (!isAuthenticated || !currentProfile) {
    return (
      <View style={styles.container}>
        <Pressable
          style={styles.button}
          onPress={handleButtonPress}
          accessibilityLabel="Sign in"
          accessibilityHint="Opens the sign in modal"
        >
          {collapsed ? (
            <Image
              style={styles.avatar}
              source={require('@/assets/images/default-avatar.jpg')}
              accessibilityLabel="Default avatar"
            />
          ) : (
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 5, gap: 10 }}>
              <OxyLogo />
              <Text style={[styles.name, { fontSize: 18 }]}>Continue with Oxy</Text>
            </View>
          )}
        </Pressable>
      </View>
    );
  }

  // Authenticated - show user profile and session switcher
  return (
    <View style={styles.container}>
      <Pressable
        style={styles.button}
        onPress={handleButtonPress}
        accessibilityLabel={`${currentProfile.name?.first || currentProfile.username}'s profile`}
        accessibilityHint="Opens the session switcher"
      >
        <View style={{ position: 'relative' }}>
          <Image
            style={styles.avatar}
            source={
              currentProfile.avatar
                ? { uri: currentProfile.avatar }
                : require('@/assets/images/default-avatar.jpg')
            }
            accessibilityLabel={`${currentProfile.name?.first || currentProfile.username}'s avatar`}
          />
          {hasMultipleSessions && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{sessions.length}</Text>
            </View>
          )}
        </View>
        {!collapsed && (
          <>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {currentProfile.name?.first || currentProfile.username}{' '}
                {currentProfile.name?.last || ''}
              </Text>
              <Text style={styles.username}>@{currentProfile.username}</Text>
            </View>
            <Ionicons
              name={hasMultipleSessions ? "people" : "chevron-down"}
              size={24}
              color={colors.primaryColor}
            />
          </>
        )}
      </Pressable>
    </View>
  );
}
