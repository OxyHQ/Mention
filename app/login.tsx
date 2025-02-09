import React, { useState, useContext } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useRouter } from 'expo-router';
import { MentionLogo } from '@/assets/mention-logo';
import { colors } from '@/styles/colors';
import axios from 'axios';
import { toast } from 'sonner';
import { storeData } from '@/utils/storage';
import api from '@/utils/api';

export default function LoginScreen() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const sessionContext = useContext(SessionContext);
    const router = useRouter();

    if (!sessionContext) {
        return null;
    }

    const { loginUser } = sessionContext;

    const handleLogin = async () => {
        if (!username || !password) {
            toast.error('Please enter both username and password');
            return;
        }

        try {
            const response = await api.post(`/auth/signin`, {
                username,
                password
            });
            
            if (response.status === 200) {
                const { accessToken, refreshToken, user } = response.data;
                
                // Store all session-related data atomically
                await Promise.all([
                    storeData('accessToken', accessToken),
                    storeData('refreshToken', refreshToken),
                    storeData('user', user),
                    storeData('session', { 
                        isAuthenticated: true, 
                        user,
                        lastRefresh: Date.now() 
                    })
                ]);

                // Update session context
                await loginUser(user);
                toast.success('Login successful');
                router.push('/');
            }
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                toast.error(error.response.data.message);
            } else {
                toast.error('Login failed');
            }
            console.error('Login failed:', error);
        }
    };

    return (
        <View style={styles.container}>
            <MentionLogo style={styles.logo} size={50} />
            <TextInput
                style={styles.input}
                placeholder="Username"
                value={username}
                onChangeText={setUsername}
                placeholderTextColor="#657786"
                autoCapitalize="none"
            />
            <TextInput
                style={styles.input}
                placeholder="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholderTextColor="#657786"
            />
            <TouchableOpacity style={styles.button} onPress={handleLogin}>
                <Text style={styles.buttonText}>Log in</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/signup')}>
                <Text style={styles.signupLink}>Don't have an account? Sign up</Text>
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
    },
    logo: {
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
    forgotPassword: {
        color: colors.primaryColor,
        fontSize: 14,
    },
    signupLink: {
        color: colors.primaryColor,
        fontSize: 14,
        marginTop: 16
    }
});
