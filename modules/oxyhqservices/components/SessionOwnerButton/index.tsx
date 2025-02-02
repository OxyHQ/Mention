import { User } from '@/assets/icons/user-icon';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useContext } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Platform } from 'react-native';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';

interface SessionOwnerButtonProps {
    collapsed?: boolean;
}

export function SessionOwnerButton({ collapsed = false }: SessionOwnerButtonProps) {
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
            avatarSource: { uri: 'https://api.mention.earth/api/files/6790749544634262da8394f2' },
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


    const styles = StyleSheet.create({
        container: {
            flex: 1,
            marginBottom: 0,
        },
        button: {
            flexDirection: 'row',
            padding: !collapsed ? 16 : 0,
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

    return (
        <View style={styles.container}>
            <TouchableOpacity style={styles.button} onPress={handleOpenBottomSheet}>
                <Image style={styles.avatar} source={OpenSessions[currentUserIndex].avatarSource} />
                {!collapsed && (
                    <>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.name}>
                                {OpenSessions[currentUserIndex].name?.first} {OpenSessions[currentUserIndex].name?.last}
                            </Text>
                            <Text>@{OpenSessions[currentUserIndex].username}</Text>
                        </View>
                        <Ionicons name="chevron-down" size={24} color={colors.primaryColor} />
                    </>
                )}
            </TouchableOpacity>
        </View>
    );
}