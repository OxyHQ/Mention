import { colors } from '../../styles/colors';
import { Ionicons } from '@expo/vector-icons';
import React, { useContext, useEffect, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, Image, Text } from 'react-native';
import { BottomSheetContext } from '../context/BottomSheetContext';
import { AuthBottomSheet } from '../AuthBottomSheet';
import { oxyClient } from '../../services/OxyClient';
import { SessionContext } from '../SessionProvider';
import { profileService } from '../../services/profile.service';
import type { Session } from '../AuthBottomSheet/types';
import type { OxyProfile } from '../../types';

interface SessionOwnerButtonProps {
  collapsed?: boolean;
}

export function SessionOwnerButton({ collapsed = false }: SessionOwnerButtonProps) {
  const [currentProfile, setCurrentProfile] = useState<OxyProfile | null>(null);
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
  const sessionContext = useContext(SessionContext);
  const isAuthenticated = !!sessionContext?.state.userId;
  const userId = sessionContext?.state.userId;

  useEffect(() => {
    const loadProfile = async () => {
      if (!userId) return;
      
      try {
        const profile = await profileService.getProfileById(userId);
        setCurrentProfile(profile);
      } catch (error) {
        console.error('Error loading profile:', error);
      }
    };

    loadProfile();
  }, [userId]);

  const handleOpenSessionSwitcher = () => {
    setBottomSheetContent(<AuthBottomSheet initialMode={isAuthenticated ? "session" : "signin"} />);
    openBottomSheet(true);
  };

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
  });

  if (!isAuthenticated || !currentProfile) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.button} onPress={handleOpenSessionSwitcher}>
          {collapsed ? (
            <Image style={styles.avatar} source={require('@/assets/images/default-avatar.jpg')} />
          ) : (
            <Text style={styles.name}>Sign in with Oxy</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={handleOpenSessionSwitcher}>
        <Image
          style={styles.avatar}
          source={
            currentProfile.avatar
              ? { uri: currentProfile.avatar }
              : require('@/assets/images/default-avatar.jpg')
          }
        />
        {!collapsed && (
          <>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {currentProfile.name?.first || currentProfile.username}{' '}
                {currentProfile.name?.last || ''}
              </Text>
              <Text style={styles.username}>@{currentProfile.username}</Text>
            </View>
            <Ionicons name="chevron-down" size={24} color={colors.primaryColor} />
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}
