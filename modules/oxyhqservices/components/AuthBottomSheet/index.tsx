/**
 * AuthBottomSheet Component
 * 
 * A modal sheet for handling authentication flows including sign in,
 * sign up, and session switching.
 */

import React, { useState, useRef, useCallback, useEffect, useContext } from 'react';
import { View, Animated } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SignInForm } from './components/SignInForm';
import { SignUpForm } from './components/SignUpForm';
import { SessionList } from './components/SessionList';
import { ProgressIndicator } from './components/ProgressIndicator';
import { useSessions } from './hooks/useSessions';
import { sharedStyles } from './components/sharedStyles';
import { AuthBottomSheetProps, AuthMode } from './types';
import { useSession } from '../../hooks';
import { authService } from '../../services/auth.service';
import { BaseBottomSheet } from '../BaseBottomSheet';
import { BottomSheetContext } from '../context/BottomSheetContext';
import { toast } from 'sonner';
import debounce from 'lodash.debounce';

interface AuthError {
    message?: string;
    details?: Record<string, string | null>;
}

interface ValidationErrors {
    username?: string;
    email?: string;
    password?: string;
}

export function AuthBottomSheet({ 
    initialMode = 'signin',
    showLogo = true
}: AuthBottomSheetProps) {
    const [mode, setMode] = useState<AuthMode>(initialMode);
    const [step, setStep] = useState(1);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [errors, setErrors] = useState<ValidationErrors>({});
    const [isCheckingUsername, setIsCheckingUsername] = useState(false);
    
    const { t } = useTranslation();
    const { sessions, isLoadingSessions } = useSessions(mode);
    const { loginUser, switchSession } = useSession();
    const { openBottomSheet } = useContext(BottomSheetContext);
    
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const scaleAnim = useRef(new Animated.Value(1)).current;
    const slideAnim = useRef(new Animated.Value(0)).current;

    const validateUsername = (username: string): string | undefined => {
        if (!username) {
            return t('Username is required');
        }
        if (username.length < 3) {
            return t('Username must be at least 3 characters');
        }
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return t('Username can only contain letters, numbers, and underscores');
        }
        return undefined;
    };

    const validateEmail = (email: string): string | undefined => {
        if (!email) {
            return t('Email is required');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return t('Please enter a valid email address');
        }
        return undefined;
    };

    const validatePassword = (password: string): string | undefined => {
        if (!password) {
            return t('Password is required');
        }
        if (password.length < 8) {
            return t('Password must be at least 8 characters');
        }
        return undefined;
    };

    const debouncedUsernameCheck = useCallback(
        debounce(async (username: string) => {
            if (username.length >= 3) {
                try {
                    setIsCheckingUsername(true);
                    const result = await authService.checkUsernameAvailability(username);
                    if (!result.available) {
                        setErrors(prev => ({ ...prev, username: result.message || t('Username is not available') }));
                    } else {
                        setErrors(prev => ({ ...prev, username: undefined }));
                    }
                } catch (error) {
                    // On API error, fall back to local validation only
                    console.error('Error checking username:', error);
                    const localValidationError = validateUsername(username);
                    if (!localValidationError) {
                        setErrors(prev => ({ ...prev, username: undefined }));
                    } else {
                        setErrors(prev => ({ ...prev, username: localValidationError }));
                    }
                } finally {
                    setIsCheckingUsername(false);
                }
            }
        }, 500),
        [validateUsername, t]
    );

    useEffect(() => {
        if (step === 1 && username) {
            debouncedUsernameCheck(username);
        }
    }, [username, step]);

    const handleSignin = async () => {
        try {
            await loginUser(username, password);
            toast.success(t('Signed in successfully'));
            openBottomSheet(false);
        } catch (error) {
            const authError = error as AuthError;
            const errorMessage = authError.message || t('Failed to sign in');
            toast.error(errorMessage);
            console.error('Sign in error:', error);
        }
    };

    const handleBack = () => {
        if (step > 1) {
            setStep(step - 1);
            Animated.sequence([
                Animated.timing(slideAnim, {
                    toValue: 20,
                    duration: 200,
                    useNativeDriver: true,
                }),
                Animated.timing(slideAnim, {
                    toValue: 0,
                    duration: 200,
                    useNativeDriver: true,
                }),
            ]).start();
        }
    };

    const handleSignup = async () => {
        let validationError: string | undefined;

        switch (step) {
            case 1:
                validationError = validateUsername(username);
                if (validationError) {
                    setErrors({ username: validationError });
                    toast.error(validationError);
                    return;
                }
                // Check for username availability error
                if (errors.username) {
                    toast.error(errors.username);
                    return;
                }
                if (isCheckingUsername) {
                    toast.error(t('Please wait while we check username availability'));
                    return;
                }
                break;
            case 2:
                validationError = validateEmail(email);
                if (validationError) {
                    setErrors({ email: validationError });
                    toast.error(validationError);
                    return;
                }
                break;
            case 3:
                validationError = validatePassword(password);
                if (validationError) {
                    setErrors({ password: validationError });
                    toast.error(validationError);
                    return;
                }
                break;
        }

        setErrors({});

        if (step < 3) {
            setStep(step + 1);
            Animated.sequence([
                Animated.timing(slideAnim, {
                    toValue: -20,
                    duration: 200,
                    useNativeDriver: true,
                }),
                Animated.timing(slideAnim, {
                    toValue: 0,
                    duration: 200,
                    useNativeDriver: true,
                }),
            ]).start();
        } else {
            try {
                await authService.register({ username, email, password });
                toast.success(t('Account created successfully'));
                switchMode('signin');
            } catch (error) {
                const authError = error as AuthError;
                const errorMessage = authError.message || t('Failed to create account');
                toast.error(errorMessage);
                console.error('Sign up error:', error);

                // Handle specific field errors if they exist
                if (authError.details) {
                    setErrors(authError.details as ValidationErrors);
                }
            }
        }
    };

    const handleSessionSwitch = async (sessionId: string) => {
        try {
            await switchSession(sessionId);
            toast.success(t('Session switched successfully'));
            openBottomSheet(false);
        } catch (error) {
            const authError = error as AuthError;
            const errorMessage = authError.message || t('Failed to switch session');
            toast.error(errorMessage);
            console.error('Session switch error:', error);
        }
    };

    const switchMode = (newMode: AuthMode) => {
        Animated.sequence([
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 0,
                    duration: 150,
                    useNativeDriver: true,
                }),
                Animated.timing(scaleAnim, {
                    toValue: 0.95,
                    duration: 150,
                    useNativeDriver: true,
                }),
            ]),
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
                }),
            ]),
        ]).start(() => {
            setMode(newMode);
            setStep(1);
            setUsername('');
            setEmail('');
            setPassword('');
        });
    };

    const renderContent = () => {
        switch (mode) {
            case 'signin':
                return (
                    <SignInForm
                        username={username}
                        password={password}
                        setUsername={setUsername}
                        setPassword={setPassword}
                        handleSignin={handleSignin}
                        switchToSignup={() => switchMode('signup')}
                        fadeAnim={fadeAnim}
                        scaleAnim={scaleAnim}
                    />
                );
            case 'signup':
                return (
                    <>
                        <ProgressIndicator currentStep={step} />
                        <SignUpForm
                            username={username}
                            email={email}
                            password={password}
                            step={step}
                            setUsername={setUsername}
                            setEmail={setEmail}
                            setPassword={setPassword}
                            handleSignup={handleSignup}
                            switchToSignin={() => switchMode('signin')}
                            slideAnim={slideAnim}
                            errors={errors}
                            handleBack={handleBack}
                        />
                    </>
                );
            case 'session':
                return (
                    <SessionList
                        sessions={sessions}
                        isLoadingSessions={isLoadingSessions}
                        handleSessionSwitch={handleSessionSwitch}
                        switchToSignin={() => switchMode('signin')}
                    />
                );
            default:
                return null;
        }
    };

    // Get the appropriate title based on the current mode and step
    const getTitle = () => {
        if (!showLogo) {
            switch (mode) {
                case 'signin':
                    return t('Sign In');
                case 'signup':
                    return `${t('Sign Up')} (${step}/3)`;
                case 'session':
                    return t('Choose Session');
                default:
                    return '';
            }
        }
        return '';
    };

    // Handle close action
    const handleClose = useCallback(() => {
        openBottomSheet(false);
    }, [openBottomSheet]);

    return (
        <BaseBottomSheet
            showLogo={showLogo}
            title={getTitle()}
            showBackButton={mode === 'signup' && step > 1}
            onBack={mode === 'signup' ? handleBack : undefined}
            onClose={handleClose}
        >
            <View style={sharedStyles.container}>
                {renderContent()}
            </View>
        </BaseBottomSheet>
    );
}