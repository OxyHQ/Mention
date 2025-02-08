import React, { useState, useContext, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Animated, Dimensions } from 'react-native';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useRouter } from 'expo-router';
import { MentionLogo } from '@/assets/mention-logo';
import { colors } from '@/styles/colors';
import axios from 'axios';
import { toast } from 'sonner';

const { width } = Dimensions.get('window');

export default function SignUpScreen() {
    const [step, setStep] = useState(1);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const router = useRouter();
    const slideAnim = useState(new Animated.Value(0))[0];
    const containerHeight = useState(new Animated.Value(200))[0];
    const currentHeight = useRef(200);

    const onContentLayout = (event: { nativeEvent: { layout: { height: any; }; }; }) => {
        const { height } = event.nativeEvent.layout;
        if (currentHeight.current !== height) {
            currentHeight.current = height;
            Animated.timing(containerHeight, {
                toValue: height,
                duration: 300,
                useNativeDriver: false,
            }).start();
        }
    };

    const animateStepChange = (nextStep: React.SetStateAction<number>, direction: number) => {
        Animated.timing(slideAnim, {
            toValue: direction,
            duration: 300,
            useNativeDriver: true,
        }).start(() => {
            setStep(nextStep);
            slideAnim.setValue(-direction);
            Animated.timing(slideAnim, {
                toValue: 0,
                duration: 300,
                useNativeDriver: true,
            }).start();
        });
    };

    const handleNextStep = async () => {
        if (step === 1) {
            animateStepChange(2, -width);
        } else if (step === 2 && username) {
            animateStepChange(3, -width);
        } else if (step === 3 && email) {
            animateStepChange(4, -width);
        } else if (step === 4 && password && confirmPassword) {
            if (password !== confirmPassword) {
                toast.error("Passwords do not match");
                return;
            }
            try {
                const response = await axios.post(`${process.env.API_URL_OXY}/auth/signup`, {
                    username,
                    email,
                    password,
                });
                if (response.status === 200) {
                    toast.success("Sign up successful");
                    router.push('/login');
                } else {
                    toast.error("Sign up failed: " + response.data.message);
                }
            } catch (error) {
                if (axios.isAxiosError(error) && error.response) {
                    toast.error("Sign up failed: " + error.response.data.message);
                } else {
                    toast.error("Sign up failed: " + (error as Error).message);
                }
            }
        } else {
            toast.error("Please fill in all fields");
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
            <Animated.View style={[styles.formContainer, { transform: [{ translateX: slideAnim }], height: containerHeight }]}>
                <View onLayout={onContentLayout} style={styles.formContent}>
                    {step === 1 && (
                        <>
                            <Text style={styles.stepTitle}>Welcome to Mention by Oxy</Text>
                            <Text style={styles.welcomeText}>Create your Oxy Account to get started</Text>
                        </>
                    )}
                    {step === 2 && (
                        <>
                            <Text style={styles.stepTitle}>Choose a Username</Text>
                            <TextInput
                                style={styles.input}
                                placeholder="Username"
                                value={username}
                                onChangeText={setUsername}
                                placeholderTextColor="#657786"
                            />
                        </>
                    )}
                    {step === 3 && (
                        <TextInput
                            style={styles.input}
                            placeholder="Email"
                            value={email}
                            onChangeText={setEmail}
                            placeholderTextColor="#657786"
                        />
                    )}
                    {step === 4 && (
                        <>
                            <TextInput
                                style={styles.input}
                                placeholder="Password"
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                placeholderTextColor="#657786"
                            />
                            <TextInput
                                style={styles.input}
                                placeholder="Confirm Password"
                                value={confirmPassword}
                                onChangeText={setConfirmPassword}
                                secureTextEntry
                                placeholderTextColor="#657786"
                            />
                        </>
                    )}
                </View>
            </Animated.View>
            <TouchableOpacity style={styles.button} onPress={handleNextStep}>
                <Text style={styles.buttonText}>{step === 4 ? 'Sign Up' : 'Next'}</Text>
            </TouchableOpacity>
            {step > 1 && (
                <TouchableOpacity style={styles.button} onPress={handleBackStep}>
                    <Text style={styles.buttonText}>Back</Text>
                </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { /* Handle sign in navigation */ }}>
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
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.primaryColor,
        marginBottom: 12,
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
    welcomeText: {
        fontSize: 16,
        color: colors.COLOR_BLACK,
        textAlign: 'center',
        marginBottom: 12,
    },
});
