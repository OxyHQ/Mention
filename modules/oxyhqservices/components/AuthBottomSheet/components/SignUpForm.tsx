import React from 'react';
import { View, TextInput, TouchableOpacity, Animated, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { sharedStyles } from './sharedStyles';
import { styles as componentStyles } from './styles';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

interface SignUpFormProps {
    username: string;
    email: string;
    password: string;
    step: number;
    setUsername: (value: string) => void;
    setEmail: (value: string) => void;
    setPassword: (value: string) => void;
    handleSignup: () => void;
    handleBack: () => void;
    switchToSignin: () => void;
    slideAnim: Animated.Value;
    errors?: {
        username?: string;
        email?: string;
        password?: string;
    };
}

export const SignUpForm: React.FC<SignUpFormProps> = ({
    username,
    email,
    password,
    step,
    setUsername,
    setEmail,
    setPassword,
    handleSignup,
    handleBack,
    switchToSignin,
    slideAnim,
    errors = {},
}) => {
    const { t } = useTranslation();

    const renderStep = () => {
        switch (step) {
            case 1:
                return (
                    <View style={sharedStyles.inputWrapper}>
                        <TextInput
                            style={[sharedStyles.input, errors.username && localStyles.inputError]}
                            placeholder={t('Choose a username')}
                            value={username}
                            onChangeText={setUsername}
                            placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                            autoCapitalize="none"
                        />
                        {errors.username && (
                            <Text style={localStyles.errorText}>{errors.username}</Text>
                        )}
                    </View>
                );
            case 2:
            case 3:
                return (
                    <View style={sharedStyles.inputWrapper}>
                        <TextInput
                            style={[sharedStyles.input, step === 2 && errors.email && localStyles.inputError, step === 3 && errors.password && localStyles.inputError]}
                            placeholder={step === 2 ? t('Enter your email') : t('Create a password')}
                            value={step === 2 ? email : password}
                            onChangeText={step === 2 ? setEmail : setPassword}
                            placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                            autoCapitalize="none"
                            keyboardType={step === 2 ? "email-address" : "default"}
                            secureTextEntry={step === 3}
                        />
                        {step === 2 && errors.email && (
                            <Text style={localStyles.errorText}>{errors.email}</Text>
                        )}
                        {step === 3 && errors.password && (
                            <Text style={localStyles.errorText}>{errors.password}</Text>
                        )}
                    </View>
                );
            default:
                return null;
        }
    };

    return (
        <View style={sharedStyles.container}>
            <Animated.View
                style={[
                    componentStyles.formWrapper,
                    {
                        transform: [
                            {
                                translateX: slideAnim,
                            },
                        ],
                    },
                ]}
            >
                <View style={sharedStyles.content}>
                    <ThemedText style={sharedStyles.title}>{t('Create Account')}</ThemedText>
                    <ThemedText style={sharedStyles.subtitle}>
                        {t('Sign up for your Oxy Account')}
                    </ThemedText>
                    {renderStep()}
                </View>
            </Animated.View>

            <View style={componentStyles.buttonContainer}>
                {step > 1 && (
                    <TouchableOpacity
                        style={[sharedStyles.button, localStyles.backButton]}
                        onPress={handleBack}
                        activeOpacity={0.8}
                    >
                        <LinearGradient
                            colors={[colors.COLOR_BLACK_LIGHT_6, colors.COLOR_BLACK_LIGHT_4]}
                            style={sharedStyles.buttonGradient}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                        >
                            <Ionicons name="arrow-back" size={24} color={colors.primaryLight} />
                        </LinearGradient>
                    </TouchableOpacity>
                )}
                <TouchableOpacity
                    style={[sharedStyles.button, componentStyles.fullWidthButton]}
                    onPress={handleSignup}
                    activeOpacity={0.8}
                >
                    <LinearGradient
                        colors={[colors.primaryColor, colors.primaryDark]}
                        style={sharedStyles.buttonGradient}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                    >
                        <ThemedText style={sharedStyles.buttonText}>
                            {step < 3 ? t('Next') : t('Sign Up')}
                        </ThemedText>
                    </LinearGradient>
                </TouchableOpacity>
            </View>

            <TouchableOpacity onPress={switchToSignin} style={componentStyles.switchModeButton}>
                <ThemedText style={componentStyles.switchModeText}>
                    {t('Already have an account?')} <ThemedText style={componentStyles.switchModeLink}>{t('Sign In')}</ThemedText>
                </ThemedText>
            </TouchableOpacity>
        </View>
    );
};

const localStyles = StyleSheet.create({
    inputError: {
        borderColor: 'red',
        borderWidth: 1,
    },
    errorText: {
        color: 'red',
        fontSize: 12,
        marginTop: 4,
        marginLeft: 4,
    },
    backButton: {
        width: 50,
        marginRight: 10,
    }
});