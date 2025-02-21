import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { toast } from 'sonner';
import { MentionLogo } from '@/assets/mention-logo';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/modules/oxyhqservices/hooks';
import { colors } from '@/styles/colors';

export default function LoginScreen() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const { loginUser } = useSession();
    const { t } = useTranslation();

    const handleLogin = async () => {
        if (!username || !password) {
            toast.error(t('Please enter both username and password'));
            return;
        }

        try {
            setIsLoading(true);
            await loginUser(username, password);
            toast.success(t('Login successful'));
            router.push('/');
        } catch (error: any) {
            const errorMessage = error?.response?.data?.message || 
                               error?.message || 
                               t('Login failed');
            
            // Show specific validation errors if available
            const details = error?.response?.data?.details;
            if (details) {
                Object.values(details)
                    .filter(Boolean)
                    .forEach(detail => toast.error(t(detail as string)));
            } else {
                toast.error(t(errorMessage));
            }
            
            console.error('Login failed:', error);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <View style={styles.container}>
            <MentionLogo style={styles.logo} size={50} />
            <TextInput
                style={styles.input}
                placeholder={t('Username')}
                value={username}
                onChangeText={setUsername}
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
                autoCapitalize="none"
                editable={!isLoading}
            />
            <TextInput
                style={styles.input}
                placeholder={t('Password')}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
                editable={!isLoading}
            />
            <TouchableOpacity 
                style={[styles.button, isLoading && styles.buttonDisabled]} 
                onPress={handleLogin}
                disabled={isLoading}
            >
                <Text style={styles.buttonText}>
                    {isLoading ? t('Logging in...') : t('Login')}
                </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/signup')} disabled={isLoading}>
                <Text style={styles.signupText}>{t("Don't have an account? Sign up")}</Text>
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
    },
    signupText: {
        marginTop: 20,
        color: colors.primaryColor,
    },
    buttonDisabled: {
        opacity: 0.7
    }
});
