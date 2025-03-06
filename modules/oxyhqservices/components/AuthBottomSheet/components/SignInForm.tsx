import React, { useRef } from 'react';
import { View, TextInput, TouchableOpacity, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { sharedStyles } from './sharedStyles';
import { styles } from './styles';
import { useTranslation } from 'react-i18next';

interface SignInFormProps {
    username: string;
    password: string;
    setUsername: (value: string) => void;
    setPassword: (value: string) => void;
    handleSignin: () => void;
    switchToSignup: () => void;
    fadeAnim: Animated.Value;
    scaleAnim: Animated.Value;
}

export const SignInForm: React.FC<SignInFormProps> = ({
    username,
    password,
    setUsername,
    setPassword,
    handleSignin,
    switchToSignup,
    fadeAnim,
    scaleAnim,
}) => {
    const { t } = useTranslation();
    const inputRefs = {
        username: useRef<TextInput>(null),
        password: useRef<TextInput>(null),
    };

    return (
        <View style={sharedStyles.container}>
            <Animated.View
                style={[
                    styles.formWrapper,
                    {
                        opacity: fadeAnim,
                        transform: [{ scale: scaleAnim }]
                    }
                ]}
            >
                <View style={sharedStyles.content}>
                    <ThemedText style={sharedStyles.title}>{t('Welcome back')}</ThemedText>
                    <ThemedText style={sharedStyles.subtitle}>{t('Sign in to your Oxy Account')}</ThemedText>
                    <View style={sharedStyles.inputWrapper}>
                        <TextInput
                            ref={inputRefs.username}
                            style={sharedStyles.input}
                            placeholder={t('Enter your username')}
                            value={username}
                            onChangeText={setUsername}
                            placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                            autoCapitalize="none"
                            returnKeyType="next"
                            onSubmitEditing={() => inputRefs.password?.current?.focus()}
                        />
                    </View>
                    <View style={sharedStyles.inputWrapper}>
                        <TextInput
                            ref={inputRefs.password}
                            style={sharedStyles.input}
                            placeholder={t('Enter your password')}
                            value={password}
                            onChangeText={setPassword}
                            secureTextEntry
                            placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                            returnKeyType="go"
                            onSubmitEditing={handleSignin}
                        />
                    </View>
                </View>
            </Animated.View>

            <View style={styles.buttonContainer}>
                <TouchableOpacity
                    style={[sharedStyles.button, styles.fullWidthButton]}
                    onPress={handleSignin}
                    activeOpacity={0.8}
                >
                    <LinearGradient
                        colors={[colors.primaryColor, colors.primaryDark]}
                        style={sharedStyles.buttonGradient}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                    >
                        <ThemedText style={sharedStyles.buttonText}>{t('Sign In')}</ThemedText>
                    </LinearGradient>
                </TouchableOpacity>
            </View>

            <TouchableOpacity onPress={switchToSignup} style={styles.switchModeButton}>
                <ThemedText style={styles.switchModeText}>
                    {t('Don\'t have an account?')} <ThemedText style={styles.switchModeLink}>{t('Sign Up')}</ThemedText>
                </ThemedText>
            </TouchableOpacity>
        </View>
    );
};