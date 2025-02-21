import React, { useState, useRef } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Animated, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { toast } from 'sonner';
import { MentionLogo } from '@/assets/mention-logo';
import { Text } from '@/components/ThemedText';
import { useTranslation } from 'react-i18next';
import { authService } from '@/modules/oxyhqservices';
import { colors } from '@/styles/colors';

const { width } = Dimensions.get('window');

export default function SignUpScreen() {
    const [step, setStep] = useState(1);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const slideAnim = useRef(new Animated.Value(0)).current;
    const router = useRouter();
    const { t } = useTranslation();

    const animateStepChange = (newStep: number, direction: number) => {
        setStep(newStep);
        Animated.timing(slideAnim, {
            toValue: -direction * (newStep - 1) * width,
            duration: 300,
            useNativeDriver: true,
        }).start();
    };

    const handleNextStep = () => {
        if (step < 4) {
            animateStepChange(step + 1, width);
        }
    };

    const handleSignup = async () => {
        if (username && email && password) {
            try {
                const user = { username, email, password };
                await authService.register(user);
                toast.success(t('success.signup'));
                router.push('/login');
            } catch (error) {
                toast.error(`${t('error.signup.failed')} ${(error as Error).message}`);
            }
        } else {
            toast.error(t('error.signup.missing_fields'));
        }
    };

    const handleBackStep = () => {
        if (step > 1) {
            animateStepChange(step - 1, width);
        }
    };

    return (
        <View style={styles.container}>
            <MentionLogo style={styles.logo} />
            <Animated.View style={[styles.formContainer, { transform: [{ translateX: slideAnim }] }]}>
                <View style={styles.formContent}>
                    {step === 1 && (
                        <>
                            <Text style={styles.stepTitle}>{t('Welcome to Mention by Oxy')}</Text>
                            <Text style={styles.welcomeText}>{t('Create your Oxy Account to get started')}</Text>
                        </>
                    )}
                    {step === 2 && (
                        <>
                            <Text style={styles.stepTitle}>{t('Choose a Username')}</Text>
                            <TextInput
                                style={styles.input}
                                placeholder={t('Username')}
                                value={username}
                                onChangeText={setUsername}
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
                                autoCapitalize="none"
                            />
                        </>
                    )}
                    {step === 3 && (
                        <>
                            <Text style={styles.stepTitle}>{t('Enter your Email')}</Text>
                            <TextInput
                                style={styles.input}
                                placeholder={t('Email')}
                                value={email}
                                onChangeText={setEmail}
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
                                autoCapitalize="none"
                                keyboardType="email-address"
                            />
                        </>
                    )}
                    {step === 4 && (
                        <>
                            <Text style={styles.stepTitle}>{t('Create a Password')}</Text>
                            <TextInput
                                style={styles.input}
                                placeholder={t('Password')}
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
                            />
                        </>
                    )}
                </View>
            </Animated.View>
            <View style={styles.buttonContainer}>
                {step > 1 && (
                    <TouchableOpacity style={styles.backButton} onPress={handleBackStep}>
                        <Text style={styles.backButtonText}>{t('Back')}</Text>
                    </TouchableOpacity>
                )}
                <TouchableOpacity
                    style={[styles.button, step === 4 && styles.finalButton]}
                    onPress={step === 4 ? handleSignup : handleNextStep}
                >
                    <Text style={styles.buttonText}>
                        {step === 4 ? t('Sign Up') : t('Next')}
                    </Text>
                </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => router.push('/login')}>
                <Text style={styles.loginText}>{t('Already have an account? Log in')}</Text>
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
        overflow: 'hidden',
    },
    logo: {
        width: 50,
        height: 50,
        marginBottom: 32,
    },
    formContainer: {
        width: '100%',
        alignItems: 'center',
    },
    formContent: {
        width: '100%',
        alignItems: 'center',
    },
    stepTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 16,
        textAlign: 'center',
        color: colors.COLOR_BLACK,
    },
    welcomeText: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 24,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    input: {
        width: '100%',
        height: 40,
        marginBottom: 16,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 5,
        color: colors.COLOR_BLACK,
    },
    buttonContainer: {
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 24,
    },
    button: {
        flex: 1,
        height: 40,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 5,
    },
    finalButton: {
        backgroundColor: colors.primaryColor,
    },
    buttonText: {
        color: colors.primaryLight,
        fontWeight: '600',
    },
    backButton: {
        marginRight: 8,
        height: 40,
        paddingHorizontal: 16,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 5,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    backButtonText: {
        color: colors.COLOR_BLACK,
    },
    loginText: {
        marginTop: 20,
        color: colors.primaryColor,
    },
});
