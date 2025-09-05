import React from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    Text,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { Logo } from './Logo';
import { colors } from '../styles/colors';

interface SignInPromptProps {
    onSignInPress?: () => void;
}

const SignInPrompt: React.FC<SignInPromptProps> = ({ onSignInPress }) => {
    const { showBottomSheet } = useOxy();

    const handleSignInPress = () => {
        if (onSignInPress) {
            onSignInPress();
        } else {
            showBottomSheet?.('SignIn');
        }
    };

    return (
        <View style={styles.signInContainer}>
            <View style={styles.signInCard}>
                <View style={styles.logoContainer}>
                    <Logo />
                </View>

                <Text style={styles.signInTitle}>Welcome to Mention</Text>
                <Text style={styles.signInSubtitle}>
                    Join the conversation and connect with people who share your interests
                </Text>

                <View style={styles.featuresContainer}>
                    <View style={styles.featureItem}>
                        <Ionicons name="chatbubble-outline" size={20} color={colors.primaryColor} />
                        <Text style={styles.featureText}>Share your thoughts</Text>
                    </View>
                    <View style={styles.featureItem}>
                        <Ionicons name="people-outline" size={20} color={colors.primaryColor} />
                        <Text style={styles.featureText}>Connect with others</Text>
                    </View>
                    <View style={styles.featureItem}>
                        <Ionicons name="heart-outline" size={20} color={colors.primaryColor} />
                        <Text style={styles.featureText}>Discover new ideas</Text>
                    </View>
                </View>

                <TouchableOpacity style={styles.signInButton} onPress={handleSignInPress}>
                    <Text style={styles.signInButtonText}>Get Started</Text>
                    <Ionicons name="arrow-forward" size={18} color={colors.COLOR_BLACK_LIGHT_9} />
                </TouchableOpacity>

                <Text style={styles.signInFooter}>
                    By signing in, you agree to our Terms of Service and Privacy Policy
                </Text>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    signInContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 24,
        backgroundColor: colors.primaryLight,
    },
    signInCard: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
        borderRadius: 20,
        padding: 32,
        width: '100%',
        maxWidth: 400,
        alignItems: 'center',
        shadowColor: colors.shadow,
        shadowOffset: {
            width: 0,
            height: 4,
        },
        shadowOpacity: 0.1,
        shadowRadius: 12,
        elevation: 8,
    },
    logoContainer: {
        marginBottom: 24,
    },
    signInTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginBottom: 12,
        textAlign: 'center',
    },
    signInSubtitle: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_3,
        marginBottom: 32,
        textAlign: 'center',
        lineHeight: 24,
    },
    featuresContainer: {
        width: '100%',
        marginBottom: 32,
    },
    featureItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
        paddingVertical: 8,
    },
    featureText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_2,
        marginLeft: 12,
        flex: 1,
    },
    signInButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 32,
        paddingVertical: 16,
        borderRadius: 12,
        minWidth: 160,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        shadowColor: colors.primaryColor,
        shadowOffset: {
            width: 0,
            height: 4,
        },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 6,
    },
    signInButtonText: {
        color: colors.COLOR_BLACK_LIGHT_9,
        fontSize: 16,
        fontWeight: '600',
        marginRight: 8,
    },
    signInFooter: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_5,
        textAlign: 'center',
        marginTop: 24,
        lineHeight: 18,
    },
});

export default SignInPrompt;
