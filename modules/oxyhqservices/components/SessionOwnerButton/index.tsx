import { User } from '@/assets/icons/user-icon';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useContext } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Platform } from 'react-native';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';

export function SessionOwnerButton() {
    const [currentUserIndex, setCurrentUserIndex] = useState(0);
    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
    const { state } = useContext(SessionContext);

    if (!state.isAuthenticated) return null;

    const OpenSessions = [
        {
            id: 'user1',
            name: {
                first: 'Nate',
                last: 'Isern',
            },
            username: 'nate',
            avatarSource: { uri: 'http://localhost:3000/api/files/6790749544634262da8394f2' },
        },
        {
            id: 'user2',
            name: {
                first: 'Mention',
            },
            username: 'mention',
            avatarSource: {
                uri: 'http://localhost:8081/assets/?unstable_path=.%2Fassets%2Fimages/default-avatar.jpg'
            },
        }
    ];

    const switchUser = (index: number) => {
        setCurrentUserIndex(index);
        openBottomSheet(false);
    };

    const handleOpenBottomSheet = () => {
        setBottomSheetContent(
            <View style={styles.contentContainer}>
                {OpenSessions.map((session, index) => (
                    <TouchableOpacity key={session.id} onPress={() => switchUser(index)} style={styles.userOption}>
                        <Image style={styles.avatar} source={session.avatarSource} />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.name}>{session.name.first} {session.name.last}</Text>
                            <Text>@{session.username}</Text>
                        </View>
                    </TouchableOpacity>
                ))}
            </View>
        );
        openBottomSheet(true);
    };

    return (
        <View style={styles.container}>
            <TouchableOpacity style={styles.button} onPress={handleOpenBottomSheet}>
                <Image style={styles.avatar} source={OpenSessions[currentUserIndex].avatarSource} />
                <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{OpenSessions[currentUserIndex].name?.first} {OpenSessions[currentUserIndex].name?.last}</Text>
                    <Text>@{OpenSessions[currentUserIndex].username}</Text>
                </View>
                <Ionicons name="chevron-down" size={24} color={colors.primaryColor} />
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        width: '100%',
        marginBottom: 0,
    },
    button: {
        flexDirection: 'row',
        padding: 10,
        backgroundColor: colors.primaryLight,
        borderRadius: 35,
        width: '100%',
        alignItems: 'center',
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 16,
        marginRight: 8,
    },
    name: {
        fontWeight: 'bold',
    },
    contentContainer: {
        flex: 1,
        padding: 36,
        alignItems: 'center',
    },
    userOption: {
        flexDirection: 'row',
        padding: 10,
        alignItems: 'center',
        width: '100%',
    },
});
