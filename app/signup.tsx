import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useRouter } from 'expo-router';
import { MentionLogo } from '@/assets/mention-logo';
import { colors } from '@/styles/colors';

export default function SignUpScreen() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const { loginUser } = useContext(SessionContext);
    const router = useRouter();

    const handleSignUp = async () => {

    };

    return (
        <View style={styles.container}>
            <MentionLogo style={styles.logo} />
            <TextInput
                style={styles.input}
                placeholder="Email, or username"
                value={username}
                onChangeText={setUsername}
                placeholderTextColor="#657786"
            />
            <TextInput
                style={styles.input}
                placeholder="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholderTextColor="#657786"
            />
            <TouchableOpacity style={styles.button} onPress={handleSignUp}>
                <Text style={styles.buttonText}>Sign Up</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { /* Handle forgot password */ }}>
                <Text style={styles.signIn}>Sign In</Text>
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
        backgroundColor: '#ffffff',
    },
    logo: {
        width: 50,
        height: 50,
        marginBottom: 32,
    },
    input: {
        width: '100%',
        height: 50,
        borderColor: colors.primaryColor,
        borderWidth: 1,
        borderRadius: 25,
        marginBottom: 12,
        paddingHorizontal: 16,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        color: colors.COLOR_BLACK,
    },
    button: {
        width: '100%',
        height: 50,
        borderRadius: 25,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 12,
    },
    buttonText: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    signIn: {
        color: colors.primaryColor,
        fontSize: 14,
    },
});
