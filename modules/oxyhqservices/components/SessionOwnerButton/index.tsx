import { User } from '@/assets/icons/user-icon';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState, useContext, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, TextInput, ScrollView } from 'react-native';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { AuthBottomSheet } from '@/modules/oxyhqservices/components/AuthBottomSheet';
import { showAuthBottomSheet } from '@/utils/auth';

interface SessionOwnerButtonProps {
  collapsed?: boolean;
}

export function SessionOwnerButton({ collapsed = false }: SessionOwnerButtonProps) {
  const [currentUserIndex, setCurrentUserIndex] = useState(0);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
  const sessionContext = useContext(SessionContext);
  const router = useRouter();

  if (!sessionContext) return null;

  const { state, switchSession, sessions } = sessionContext;

  const getBottomSheetContent = () => {
    const filteredSessions = sessions.filter(session => {
      const searchLower = searchText.toLowerCase();
      const firstName = session.name?.first?.toLowerCase() || '';
      const lastName = session.name?.last?.toLowerCase() || '';
      const username = session.username?.toLowerCase() || '';

      return firstName.includes(searchLower) ||
        lastName.includes(searchLower) ||
        username.includes(searchLower);
    });

    return (
      <ScrollView contentContainerStyle={styles.bottomSheetContainer} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Switch Sessions</Text>
          <TouchableOpacity onPress={() => { openBottomSheet(false); setIsSheetOpen(false); }}>
            <Ionicons name="close" size={24} color={colors.primaryColor} />
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.searchInput}
          placeholder="Search..."
          value={searchText}
          onChangeText={setSearchText}
        />
        {filteredSessions.length > 0 ? (
          filteredSessions.map((session, index) => (
            <TouchableOpacity key={session.id} onPress={() => switchUser(index)} style={styles.userOption}>
              <Image style={styles.avatar} source={session.avatar ? { uri: session.avatar } : require('@/assets/images/default-avatar.jpg')} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.name}>
                  {session.name?.first || session.username || 'Unknown'} {session.name?.last || ''}
                </Text>
                {session.username && <Text>@{session.username}</Text>}
              </View>
            </TouchableOpacity>
          ))
        ) : (
          <View style={styles.emptyState}>
            <Text>No sessions found</Text>
          </View>
        )}
      </ScrollView>
    );
  };

  const handleOpenBottomSheet = () => {
    setBottomSheetContent(getBottomSheetContent());
    setIsSheetOpen(true);
    openBottomSheet(true);
  };

  const switchUser = async (index: number) => {
    try {
      if (!sessions[index]?.id) {
        throw new Error('Invalid session selected');
      }

      await switchSession(sessions[index].id);
      setCurrentUserIndex(index);
      openBottomSheet(false);
      setIsSheetOpen(false);
    } catch (error) {
      const errorMessage = error instanceof Error ?
        error.message :
        'Failed to switch session. Please try logging in again.';

      console.error('Session switch failed:', errorMessage);

      setBottomSheetContent(
        <View style={styles.bottomSheetContainer}>
          <View style={styles.header}>
            <Text style={[styles.headerTitle, { color: colors.primaryColor }]}>Session Switch Failed</Text>
            <TouchableOpacity onPress={() => { openBottomSheet(false); setIsSheetOpen(false); }}>
              <Ionicons name="close" size={24} color={colors.primaryColor} />
            </TouchableOpacity>
          </View>
          <Text style={{ color: 'red', marginTop: 10, marginBottom: 20 }}>{errorMessage}</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.retryButton]}
              onPress={() => setBottomSheetContent(getBottomSheetContent())}>
              <Text style={styles.buttonText}>Try Again</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.loginButton]}
              onPress={() => {
                openBottomSheet(false);
                setIsSheetOpen(false);
                showAuthBottomSheet();
              }}>
              <Text style={[styles.buttonText, { color: colors.primaryLight }]}>Login Again</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
  };

  useEffect(() => {
    if (isSheetOpen) {
      setBottomSheetContent(getBottomSheetContent());
    }
  }, [searchText, isSheetOpen, setBottomSheetContent]);

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
    },
    bottomSheetContainer: {
      flex: 1,
      padding: 20,
      backgroundColor: '#fff',
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 10,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
    },
    searchInput: {
      borderWidth: 1,
      borderColor: colors.COLOR_BLACK_LIGHT_6,
      borderRadius: 35,
      paddingVertical: 10,
      paddingHorizontal: 20,
      marginBottom: 15,
    },
    userOption: {
      flexDirection: 'row',
      padding: 12,
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: '#eee',
    },
    emptyState: {
      padding: 20,
      alignItems: 'center',
      justifyContent: 'center'
    },
    buttonRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 10,
    },
    retryButton: {
      flex: 1,
      backgroundColor: colors.primaryLight,
      borderWidth: 1,
      borderColor: colors.primaryColor,
      paddingVertical: 10,
      borderRadius: 20,
      alignItems: 'center',
    },
    loginButton: {
      flex: 1,
      backgroundColor: colors.primaryColor,
      paddingVertical: 10,
      borderRadius: 20,
      alignItems: 'center',
    },
    buttonText: {
      color: colors.primaryColor,
      fontWeight: '600',
    }
  });

  if (!state.user || !sessions[currentUserIndex] || !sessions[currentUserIndex].username) return null;

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={handleOpenBottomSheet}>
        <Image
          style={styles.avatar}
          source={sessions[currentUserIndex].avatar ?
            { uri: sessions[currentUserIndex].avatar } :
            require('@/assets/images/default-avatar.jpg')
          }
        />
        {!collapsed && (
          <>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {sessions[currentUserIndex].name?.first || sessions[currentUserIndex].username} {sessions[currentUserIndex].name?.last || ''}
              </Text>
              <Text>@{sessions[currentUserIndex].username}</Text>
            </View>
            <Ionicons name="chevron-down" size={24} color={colors.primaryColor} />
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}
