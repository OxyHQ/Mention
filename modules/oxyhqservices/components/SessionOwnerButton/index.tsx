import { User } from '@/assets/icons/user-icon';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useContext, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, TextInput, ScrollView } from 'react-native';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';

interface SessionOwnerButtonProps {
  collapsed?: boolean;
}

export function SessionOwnerButton({ collapsed = false }: SessionOwnerButtonProps) {
  const [currentUserIndex, setCurrentUserIndex] = useState(0);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
  const { state, switchSession, sessions } = useContext(SessionContext);

  const getBottomSheetContent = () => {
    const filteredSessions = sessions.filter(session =>
      session.name.first.toLowerCase().includes(searchText.toLowerCase())
    );
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
        {filteredSessions.map((session, index) => (
          <TouchableOpacity key={session.id} onPress={() => switchUser(index)} style={styles.userOption}>
            <Image style={styles.avatar} source={session.avatarSource} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.name}>
                {session.name.first} {session.name.last || ''}
              </Text>
              <Text>@{session.username}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    );
  };

  const handleOpenBottomSheet = () => {
    setBottomSheetContent(getBottomSheetContent());
    setIsSheetOpen(true);
    openBottomSheet(true);
  };

  const switchUser = (index: number) => {
    switchSession(sessions[index].id);
    setCurrentUserIndex(index);
    openBottomSheet(false);
    setIsSheetOpen(false);
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
  });

  if (!state.isAuthenticated) return null;

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={handleOpenBottomSheet}>
        <Image style={styles.avatar} source={sessions[currentUserIndex].avatarSource} />
        {!collapsed && (
          <>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {sessions[currentUserIndex].name.first} {sessions[currentUserIndex].name.last}
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
