import { colors } from '../../styles/colors';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useContext } from 'react';
import { View, TouchableOpacity, StyleSheet, Image, Text } from 'react-native';
import { BottomSheetContext } from '../context/BottomSheetContext';
import { SessionContext } from '../SessionProvider';
import { AuthBottomSheet } from '../AuthBottomSheet';
import type { Session } from '../AuthBottomSheet/types';

interface SessionOwnerButtonProps {
  collapsed?: boolean;
}

export function SessionOwnerButton({ collapsed = false }: SessionOwnerButtonProps) {
  const context = useContext(SessionContext);
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
  const router = useRouter();

  if (!context) return null;
  const { sessions, state } = context;
  const currentSession = sessions.find(session => session.id === state.userId);

  const handleOpenSessionSwitcher = () => {
    setBottomSheetContent(<AuthBottomSheet initialMode="session" />);
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
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 35,
      marginRight: 8,
    },
    name: {
      fontWeight: 'bold',
      color: colors.COLOR_BLACK,
    },
    username: {
      color: colors.COLOR_BLACK_LIGHT_4,
    }
  });

  if (!state.user || !currentSession || !currentSession.profile) return null;

  const currentProfile = currentSession.profile;

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={handleOpenSessionSwitcher}>
        <Image
          style={styles.avatar}
          source={currentProfile.avatar ?
            { uri: currentProfile.avatar } :
            require('@/assets/images/default-avatar.jpg')
          }
        />
        {!collapsed && (
          <>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {currentProfile.name?.first || currentProfile.username} {currentProfile.name?.last || ''}
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
