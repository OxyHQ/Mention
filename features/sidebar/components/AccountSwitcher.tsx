import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

interface AccountSwitcherProps {
    expanded: boolean;
}

const AccountSwitcher: React.FC<AccountSwitcherProps> = ({ expanded }) => {
    return (
        <TouchableOpacity style={styles.container}>
            <Image
                source={{ uri: 'https://placekitten.com/100/100' }}
                style={styles.avatar}
            />
            {expanded && (
                <View style={styles.userInfo}>
                    <Text style={styles.name}>John Doe</Text>
                    <Text style={styles.handle}>@johndoe</Text>
                </View>
            )}
            {expanded && <Feather name="more-horizontal" size={20} color="#657786" />}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 10,
        borderRadius: 50,
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
    },
    userInfo: {
        marginLeft: 10,
        flex: 1,
    },
    name: {
        fontWeight: 'bold',
    },
    handle: {
        color: '#657786',
    },
});

export default AccountSwitcher;