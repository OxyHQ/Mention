import React, { useState, useRef, useContext, useEffect } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Animated, ScrollView, Dimensions, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { toast } from 'sonner';
import { MentionLogo } from '@/assets/mention-logo';
import { ThemedText } from '@/components/ThemedText';
import { useTranslation } from 'react-i18next';
import { authService } from '@/modules/oxyhqservices';
import { colors } from '@/styles/colors';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '@/modules/oxyhqservices/hooks';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';

const { width } = Dimensions.get('window');

type AuthMode = 'signin' | 'signup' | 'session';

interface UserSession {
    id: string;
    username: string;
    name?: {
        first?: string;
        last?: string;
    };
    avatar?: string;
}

export function AuthBottomSheet() {
    const [mode, setMode] = useState<AuthMode>('signin');
    const [step, setStep] = useState(1);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [searchText, setSearchText] = useState('');
    const slideAnim = useRef(new Animated.Value(0)).current;
    const router = useRouter();
    const { t } = useTranslation();
    const { openBottomSheet } = useContext(BottomSheetContext);
    const { loginUser } = useSession();
    const sessionContext = useContext(SessionContext);
    const availableSessions = (sessionContext as any)?.sessions as UserSession[] || [];

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
                setMode('signin');
                resetForm();
            } catch (error) {
                toast.error(`${t('error.signup.failed')} ${(error as Error).message}`);
            }
        } else {
            toast.error(t('error.signup.missing_fields'));
        }
    };

    const handleSignin = async () => {
        if (!username || !password) {
            toast.error(t('Please enter both username and password'));
            return;
        }

        try {
            await loginUser(username, password);
            toast.success(t('Login successful'));
            openBottomSheet(false);
            router.push('/');
        } catch (error: any) {
            const errorMessage = error?.response?.data?.message ||
                error?.message ||
                t('Login failed');

            const details = error?.response?.data?.details;
            if (details) {
                Object.values(details)
                    .filter(Boolean)
                    .forEach(detail => toast.error(t(detail as string)));
            } else {
                toast.error(t(errorMessage));
            }
        }
    };

    const handleBackStep = () => {
        if (step > 1) {
            animateStepChange(step - 1, width);
        }
    };

    const resetForm = () => {
        setUsername('');
        setEmail('');
        setPassword('');
        setStep(1);
        slideAnim.setValue(0);
    };

    const handleSessionSwitch = async (userId: string) => {
        try {
            await sessionContext?.switchSession(userId);
            toast.success(t('Session switched successfully'));
            openBottomSheet(false);
            router.push('/');
        } catch (error) {
            toast.error(t('Failed to switch session'));
        }
    };

    const renderSignin = () => (
        <View style={styles.formContent}>
            <ThemedText style={styles.stepTitle}>{t('Welcome back')}</ThemedText>
            <TextInput
                style={styles.input}
                placeholder={t('Username')}
                value={username}
                onChangeText={setUsername}
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
                autoCapitalize="none"
            />
            <TextInput
                style={styles.input}
                placeholder={t('Password')}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
            />
            <TouchableOpacity style={styles.button} onPress={handleSignin}>
                <ThemedText style={styles.buttonText}>{t('Sign In')}</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { resetForm(); setMode('signup'); }}>
                <ThemedText style={styles.switchModeText}>{t("Don't have an account? Sign up")}</ThemedText>
            </TouchableOpacity>
        </View>
    );

    const renderSignup = () => (
        <ScrollView contentContainerStyle={styles.formContainer}>
            <Animated.View style={[styles.formContent, { transform: [{ translateX: slideAnim }] }]}>
                {step === 1 && (
                    <>
                        <ThemedText style={styles.stepTitle}>{t('Welcome to Mention by Oxy')}</ThemedText>
                        <ThemedText style={styles.welcomeText}>{t('Create your Oxy Account to get started')}</ThemedText>
                    </>
                )}
                {step === 2 && (
                    <>
                        <ThemedText style={styles.stepTitle}>{t('Choose a Username')}</ThemedText>
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
                        <ThemedText style={styles.stepTitle}>{t('Enter your Email')}</ThemedText>
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
                        <ThemedText style={styles.stepTitle}>{t('Create a Password')}</ThemedText>
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
                <View style={styles.buttonContainer}>
                    {step > 1 && (
                        <TouchableOpacity style={styles.backButton} onPress={handleBackStep}>
                            <ThemedText style={styles.backButtonText}>{t('Back')}</ThemedText>
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity
                        style={[styles.button, step === 4 && styles.finalButton]}
                        onPress={step === 4 ? handleSignup : handleNextStep}
                    >
                        <ThemedText style={styles.buttonText}>
                            {step === 4 ? t('Sign Up') : t('Next')}
                        </ThemedText>
                    </TouchableOpacity>
                </View>
                <TouchableOpacity onPress={() => { resetForm(); setMode('signin'); }}>
                    <ThemedText style={styles.switchModeText}>{t('Already have an account? Log in')}</ThemedText>
                </TouchableOpacity>
            </Animated.View>
        </ScrollView>
    );

    const renderSessionList = () => {
        const filteredSessions = availableSessions.filter(session => {
            const searchLower = searchText.toLowerCase();
            const firstName = session.name?.first?.toLowerCase() || '';
            const lastName = session.name?.last?.toLowerCase() || '';
            const username = session.username?.toLowerCase() || '';

            return firstName.includes(searchLower) ||
                lastName.includes(searchLower) ||
                username.includes(searchLower);
        });

        return (
            <View style={styles.formContent}>
                <ThemedText style={styles.stepTitle}>{t('Switch Account')}</ThemedText>
                <TextInput
                    style={styles.input}
                    placeholder={t('Search accounts...')}
                    value={searchText}
                    onChangeText={setSearchText}
                    placeholderTextColor={colors.COLOR_BLACK_LIGHT_6}
                    autoCapitalize="none"
                />
                <ScrollView style={styles.sessionList}>
                    {filteredSessions.map((session) => (
                        <TouchableOpacity
                            key={session.id}
                            style={styles.sessionItem}
                            onPress={() => handleSessionSwitch(session.id)}
                        >
                            <Image
                                style={styles.avatar}
                                source={
                                    session.avatar
                                        ? { uri: session.avatar }
                                        : require('@/assets/images/default-avatar.jpg')
                                }
                            />
                            <View style={styles.sessionInfo}>
                                <ThemedText style={styles.sessionName}>
                                    {session.name?.first || session.username || 'Unknown'} {session.name?.last || ''}
                                </ThemedText>
                                {session.username && (
                                    <ThemedText style={styles.sessionUsername}>@{session.username}</ThemedText>
                                )}
                            </View>
                            {sessionContext?.state.userId === session.id && (
                                <Ionicons name="checkmark-circle" size={24} color={colors.primaryColor} />
                            )}
                        </TouchableOpacity>
                    ))}
                </ScrollView>
                <TouchableOpacity
                    style={styles.addAccountButton}
                    onPress={() => { resetForm(); setMode('signin'); }}
                >
                    <Ionicons name="add-circle-outline" size={24} color={colors.primaryColor} />
                    <ThemedText style={styles.addAccountText}>{t('Add another account')}</ThemedText>
                </TouchableOpacity>
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <MentionLogo style={styles.logo} />
                <TouchableOpacity onPress={() => openBottomSheet(false)}>
                    <Ionicons name="close" size={24} color={colors.primaryColor} />
                </TouchableOpacity>
            </View>
            {mode === 'signin' ? renderSignin() : mode === 'signup' ? renderSignup() : renderSessionList()}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 16,
        backgroundColor: colors.primaryLight,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        maxHeight: '90%',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
    },
    logo: {
        width: 40,
        height: 40,
    },
    formContainer: {
        flexGrow: 1,
    },
    formContent: {
        alignItems: 'center',
        width: '100%',
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
        height: 50,
        marginBottom: 16,
        paddingHorizontal: 16,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 25,
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
        height: 50,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 25,
    },
    finalButton: {
        backgroundColor: colors.primaryColor,
    },
    buttonText: {
        color: colors.primaryLight,
        fontWeight: '600',
        fontSize: 16,
    },
    backButton: {
        marginRight: 8,
        height: 50,
        paddingHorizontal: 16,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 25,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    backButtonText: {
        color: colors.COLOR_BLACK,
    },
    switchModeText: {
        marginTop: 20,
        color: colors.primaryColor,
        textAlign: 'center',
    },
    sessionList: {
        width: '100%',
        maxHeight: 300,
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
    },
    sessionInfo: {
        flex: 1,
        marginLeft: 12,
    },
    sessionName: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.COLOR_BLACK,
    },
    sessionUsername: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    addAccountButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 16,
        padding: 12,
        borderRadius: 25,
        borderWidth: 1,
        borderColor: colors.primaryColor,
    },
    addAccountText: {
        marginLeft: 8,
        fontSize: 16,
        color: colors.primaryColor,
        fontWeight: '600',
    },
}); 