import { User } from '@/assets/icons/user-icon';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet, Image } from 'react-native';

export function SessionOwnerButton() {

    const currentUser = {
        id: 'user1',
        name: {
            first: 'Nate',
            last: 'Isern',
        },
        username: 'nate',
        avatarSource: { uri: 'http://localhost:3000/api/files/6790749544634262da8394f2' },
    };

    const switchUser = () => {
        console.log('Switching user...');
    };

    return (
        <View style={styles.container}>
            <Image style={styles.avatar} source={currentUser.avatarSource} />
            <View style={{ flex: 1 }}>
                <Text style={styles.name}>{currentUser.name.first} {currentUser.name.last}</Text>
                <Text>@{currentUser.username}</Text>
            </View>
            <Ionicons name="chevron-down" size={24} color={colors.primaryColor} />
        </View>
    );
}


const styles = StyleSheet.create({
    container: {
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
});
