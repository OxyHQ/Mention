import React, { useState, useContext, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Animated, Dimensions } from 'react-native';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useRouter } from 'expo-router';
import { MentionLogo } from '@/assets/mention-logo';
import { colors } from '@/styles/colors';

const { width } = Dimensions.get('window');

export default function SignUpScreen() {
    const [step, setStep] = useState(1);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const { loginUser } = useContext(SessionContext);
    const router = useRouter();
    const slideAnim = useState(new Animated.Value(0))[0];
    const containerHeight = useState(new Animated.Value(200))[0];
    const currentHeight = useRef(200);

    const onContentLayout = (event) => {
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

    const animateStepChange = (nextStep, direction) => {
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

    const handleNextStep = () => {
        if (step === 1 && username) {
            animateStepChange(2, -width);
        } else if (step === 2 && email) {
            animateStepChange(3, -width);
        } else if (step === 3 && password && confirmPassword) {
            if (password !== confirmPassword) {
                alert("Passwords do not match");
                return;
            }
            // Add sign-up logic here
        } else {
            alert("Please fill in all fields");
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
                    {step === 2 && (
                        <TextInput
                            style={styles.input}
                            placeholder="Email"
                            value={email}
                            onChangeText={setEmail}
                            placeholderTextColor="#657786"
                        />
                    )}
                    {step === 3 && (
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
                <Text style={styles.buttonText}>{step === 3 ? 'Sign Up' : 'Next'}</Text>
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
});
