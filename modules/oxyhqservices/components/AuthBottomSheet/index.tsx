import React, { useState, useRef, useContext, useEffect } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Animated, ScrollView, Dimensions, Image, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { toast } from 'sonner';
import { ThemedText } from '@/components/ThemedText';
import { useTranslation } from 'react-i18next';
import { authService } from '@/modules/oxyhqservices';
import { colors } from '@/styles/colors';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '@/modules/oxyhqservices/hooks';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { LinearGradient } from 'expo-linear-gradient';
import { BaseBottomSheet } from '../BaseBottomSheet';
import { sharedStyles } from '../../styles/shared';

const { width } = Dimensions.get('window');

type AuthMode = 'signin' | 'signup' | 'session';

interface AuthBottomSheetProps {
    initialMode?: AuthMode;
}

interface UserSession {
    id: string;
    username: string;
    name?: {
        first?: string;
        last?: string;
    };
    avatar?: string;
}

export function AuthBottomSheet({ initialMode = 'signin' }: AuthBottomSheetProps) {
    const [mode, setMode] = useState<AuthMode>(initialMode);
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
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const scaleAnim = useRef(new Animated.Value(1)).current;
    const inputRefs = {
        username: useRef<TextInput>(null),
        email: useRef<TextInput>(null),
        password: useRef<TextInput>(null),
    };

    // Animation functions
    const animateStepChange = (newStep: number, direction: number) => {
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 150,
                useNativeDriver: true,
            }),
            Animated.timing(scaleAnim, {
                toValue: direction > 0 ? 0.95 : 1.05,
                duration: 150,
                useNativeDriver: true,
            }),
            Animated.timing(slideAnim, {
                toValue: -(newStep - 1),
                duration: 300,
                useNativeDriver: true,
            })
        ]).start(() => {
            setStep(newStep);
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 1,
                    duration: 150,
                    useNativeDriver: true,
                }),
                Animated.timing(scaleAnim, {
                    toValue: 1,
                    duration: 150,
                    useNativeDriver: true,
                })
            ]).start(() => {
                if (newStep === 2) inputRefs.username.current?.focus();
                if (newStep === 3) inputRefs.email.current?.focus();
                if (newStep === 4) inputRefs.password.current?.focus();
            });
        });
    };

    // Event handlers
    const handleNextStep = () => {
        if (step < 4) {
            animateStepChange(step + 1, width);
        }
    };

    const handleBackStep = () => {
        if (step > 1) {
            animateStepChange(step - 1, width);
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

    const handleSignup = async () => {
        if (!username || !email || !password) {
            toast.error(t('error.signup.missing_fields'));
            return;
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            toast.error(t('error.signup.invalid_email'));
            return;
        }

        try {
            const user = { username, email, password };
            const response = await authService.register(user);

            if (response.success && response.accessToken && response.user) {
                await loginUser(username, password);
                toast.success(t('success.signup'));
                openBottomSheet(false);
                router.push('/');
            } else {
                toast.error(response.message || t('error.signup.failed'));
            }
        } catch (error: any) {
            if (error.response?.status === 409) {
                toast.error(t('error.signup.user_exists'));
            } else if (error.details) {
                Object.values(error.details)
                    .filter(Boolean)
                    .forEach(detail => toast.error(t(detail as string)));
            } else {
                const errorMessage = error?.message || t('error.signup.failed');
                toast.error(errorMessage);
            }
        }
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

    const resetForm = () => {
        setUsername('');
        setEmail('');
        setPassword('');
        setStep(1);
        slideAnim.setValue(0);
    };

    const switchToSignup = () => {
        resetForm();
        setMode('signup');
    };

    const switchToSignin = () => {
        resetForm();
        setMode('signin');
    };

    // Render functions
    const renderProgressIndicator = () => (
        <View style={sharedStyles.progressContainer}>
            {[1, 2, 3, 4].map((stepNum) => (
                <View key={stepNum} style={styles.progressWrapper}>
                    <View
                        style={[
                            sharedStyles.progressDot,
                            stepNum === step && sharedStyles.progressDotActive,
                            stepNum < step && sharedStyles.progressDotCompleted,
                        ]}
                    />
                    {stepNum < 4 && (
                        <View
                            style={[
                                sharedStyles.progressLine,
                                stepNum < step && sharedStyles.progressLineCompleted,
                            ]}
                        />
                    )}
                </View>
            ))}
        </View>
    );

    const renderSignin = () => (
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
                <ThemedText style={styles.switchModeText}>{t("Don't have an account? Sign up")}</ThemedText>
            </TouchableOpacity>
        </View>
    );

    const renderSignup = () => (
        <View style={sharedStyles.container}>
            {renderProgressIndicator()}
            <Animated.View
                style={[
                    styles.formWrapper,
                    {
                        opacity: fadeAnim,
                        transform: [
                            { scale: scaleAnim },
                            { translateX: Animated.multiply(slideAnim, width) }
                        ]
                    }
                ]}
            >
                {step === 1 && (
                    <View style={sharedStyles.content}>
                        <ThemedText style={sharedStyles.title}>{t('Welcome to Mention by Oxy')}</ThemedText>
                        <ThemedText style={sharedStyles.subtitle}>{t('Create your Oxy Account to get started')}</ThemedText>
                    </View>
                )}
                {step === 2 && (
                    <View style={sharedStyles.content}>
                        <ThemedText style={sharedStyles.title}>{t('Choose a Username')}</ThemedText>
                        <View style={sharedStyles.inputWrapper}>
                            <TextInput
                                style={sharedStyles.input}
                                placeholder={t('Choose a username for your account')}
                                value={username}
                                onChangeText={setUsername}
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                                autoCapitalize="none"
                            />
                        </View>
                    </View>
                )}
                {step === 3 && (
                    <View style={sharedStyles.content}>
                        <ThemedText style={sharedStyles.title}>{t('Enter your Email')}</ThemedText>
                        <View style={sharedStyles.inputWrapper}>
                            <TextInput
                                style={sharedStyles.input}
                                placeholder={t('Enter your email address')}
                                value={email}
                                onChangeText={setEmail}
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                                autoCapitalize="none"
                                keyboardType="email-address"
                            />
                        </View>
                    </View>
                )}
                {step === 4 && (
                    <View style={sharedStyles.content}>
                        <ThemedText style={sharedStyles.title}>{t('Create a Password')}</ThemedText>
                        <View style={sharedStyles.inputWrapper}>
                            <TextInput
                                style={sharedStyles.input}
                                placeholder={t('Create a strong password')}
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                            />
                        </View>
                    </View>
                )}
            </Animated.View>

            <View style={styles.buttonContainer}>
                {step > 1 && (
                    <TouchableOpacity
                        style={sharedStyles.buttonOutline}
                        onPress={handleBackStep}
                        activeOpacity={0.8}
                    >
                        <ThemedText style={sharedStyles.buttonOutlineText}>{t('Back')}</ThemedText>
                    </TouchableOpacity>
                )}
                <TouchableOpacity
                    style={[sharedStyles.button, step === 4 && styles.finalButton]}
                    onPress={step === 4 ? handleSignup : handleNextStep}
                    activeOpacity={0.8}
                >
                    <LinearGradient
                        colors={[colors.primaryColor, colors.primaryDark]}
                        style={sharedStyles.buttonGradient}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                    >
                        <ThemedText style={sharedStyles.buttonText}>
                            {step === 4 ? t('Sign Up') : t('Next')}
                        </ThemedText>
                    </LinearGradient>
                </TouchableOpacity>
            </View>

            <TouchableOpacity onPress={switchToSignin} style={styles.switchModeButton}>
                <ThemedText style={styles.switchModeText}>{t('Already have an account? Log in')}</ThemedText>
            </TouchableOpacity>
        </View>
    );

    const renderSessionList = () => {
        const currentSession = availableSessions.find(session => session.id === sessionContext?.state.userId);
        const otherSessions = availableSessions.filter(session => session.id !== sessionContext?.state.userId);

        return (
            <View style={sharedStyles.container}>
                {currentSession && (
                    <View style={styles.currentSessionContainer}>
                        <Image
                            style={styles.currentAvatar}
                            source={
                                currentSession.avatar
                                    ? { uri: currentSession.avatar }
                                    : require('@/assets/images/default-avatar.jpg')
                            }
                        />
                        <View style={styles.currentSessionInfo}>
                            <ThemedText style={styles.currentSessionName}>
                                {currentSession.name?.first || currentSession.username || 'Unknown'} {currentSession.name?.last || ''}
                            </ThemedText>
                            {currentSession.username && (
                                <ThemedText style={styles.currentSessionEmail}>@{currentSession.username}</ThemedText>
                            )}
                            <TouchableOpacity
                                style={styles.manageAccountButton}
                                onPress={() => router.push('/settings')}
                            >
                                <ThemedText style={styles.manageAccountText}>Manage your Oxy Account</ThemedText>
                            </TouchableOpacity>
                        </View>
                    </View>
                )}

                <View style={styles.sessionListContainer}>
                    <TouchableOpacity
                        style={styles.showMoreButton}
                        onPress={() => { }}
                    >
                        <View style={styles.showMoreLeft}>
                            <Ionicons name="people" size={20} color={colors.COLOR_BLACK} />
                            <ThemedText style={styles.showMoreText}>Show all accounts</ThemedText>
                        </View>
                        <Ionicons name="chevron-down" size={20} color={colors.COLOR_BLACK} />
                    </TouchableOpacity>

                    {otherSessions.map((session) => (
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
                                    <ThemedText style={styles.sessionEmail}>@{session.username}</ThemedText>
                                )}
                            </View>
                        </TouchableOpacity>
                    ))}
                </View>

                <View style={styles.bottomButtons}>
                    <TouchableOpacity
                        style={styles.addAccountButton}
                        onPress={() => { resetForm(); setMode('signin'); }}
                    >
                        <Ionicons name="add-circle-outline" size={24} color={colors.COLOR_BLACK} />
                        <ThemedText style={styles.addAccountText}>Add another account</ThemedText>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.signOutButton}
                        onPress={() => router.push('/settings/accounts')}
                    >
                        <Ionicons name="log-out-outline" size={24} color={colors.COLOR_BLACK} />
                        <ThemedText style={styles.signOutText}>Sign out</ThemedText>
                    </TouchableOpacity>
                </View>

                <View style={styles.footer}>
                    <TouchableOpacity onPress={() => router.push('/privacy')}>
                        <ThemedText style={styles.footerText}>Privacy Policy</ThemedText>
                    </TouchableOpacity>
                    <Text style={styles.footerDot}>•</Text>
                    <TouchableOpacity onPress={() => router.push('/terms')}>
                        <ThemedText style={styles.footerText}>Terms of Service</ThemedText>
                    </TouchableOpacity>
                </View>
            </View>
        );
    };

    return (
        <BaseBottomSheet
            onClose={() => openBottomSheet(false)}
            showBackButton={mode === 'signup' && step > 1}
            onBack={handleBackStep}
            showLogo={true}
        >
            {mode === 'signin' && renderSignin()}
            {mode === 'signup' && renderSignup()}
            {mode === 'session' && renderSessionList()}
        </BaseBottomSheet>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        gap: 16,
    },
    formWrapper: {
        flex: 1,
        width: '100%',
        alignItems: 'center',
    },
    progressWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    buttonContainer: {
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 24,
        paddingHorizontal: 8,
    },
    finalButton: {
        backgroundColor: colors.primaryColor,
    },
    switchModeButton: {
        marginTop: 16,
        marginBottom: 8,
        paddingVertical: 8,
        alignItems: 'center',
    },
    switchModeText: {
        color: colors.primaryColor,
        textAlign: 'center',
    },
    sessionListContainer: {
        borderRadius: 16,
        marginBottom: 8,
        overflow: 'hidden',
    },
    showMoreButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderRadius: 35,
        backgroundColor: colors.primaryLight,
    },
    showMoreLeft: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    showMoreText: {
        marginLeft: 12,
        fontSize: 16,
        color: colors.COLOR_BLACK,
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
    },
    avatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
    },
    sessionInfo: {
        flex: 1,
        marginLeft: 12,
    },
    sessionName: {
        fontSize: 14,
        color: colors.COLOR_BLACK,
        fontWeight: '500',
    },
    sessionEmail: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    bottomButtons: {
        borderRadius: 16,
        overflow: 'hidden',
        gap: 4,
    },
    addAccountButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_8,
        backgroundColor: colors.primaryLight,
    },
    addAccountText: {
        marginLeft: 12,
        fontSize: 16,
        color: colors.COLOR_BLACK,
    },
    signOutButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        backgroundColor: colors.primaryLight,
    },
    signOutText: {
        marginLeft: 12,
        fontSize: 16,
        color: colors.COLOR_BLACK,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 16,
        paddingBottom: 8,
    },
    footerText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    footerDot: {
        marginHorizontal: 8,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    closeButton: {
        position: 'absolute',
        top: 16,
        right: 16,
        padding: 8,
        zIndex: 1,
    },
    currentSessionContainer: {
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
    },
    currentAvatar: {
        width: 72,
        height: 72,
        borderRadius: 36,
    },
    currentSessionInfo: {
        flex: 1,
        textAlign: 'center',
    },
    currentSessionName: {
        fontSize: 20,
        fontWeight: '500',
        color: colors.COLOR_BLACK,
        marginBottom: 4,
        textAlign: 'center',
    },
    currentSessionEmail: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginBottom: 16,
        textAlign: 'center',
    },
    manageAccountButton: {
        alignSelf: 'flex-start',
    },
    manageAccountText: {
        color: colors.primaryColor,
        fontSize: 14,
        fontWeight: '500',
    },
    fullWidthButton: {
        flex: 1,
        maxWidth: 400,
        alignSelf: 'center',
    },
}); 