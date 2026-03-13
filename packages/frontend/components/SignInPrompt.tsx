import React from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    Text,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';
import { Logo } from './Logo';
import { useTheme } from '@/hooks/useTheme';

interface SignInPromptProps {
    onSignInPress?: () => void;
}

const SignInPrompt: React.FC<SignInPromptProps> = ({ onSignInPress }) => {
    const { signIn } = useAuth();
    const theme = useTheme();

    const handleSignInPress = () => {
        if (onSignInPress) {
            onSignInPress();
        } else {
            signIn().catch(() => {});
        }
    };

    return (
        <View className="bg-primary/10" style={styles.signInContainer}>
            <View className="bg-background" style={styles.signInCard}>
                <View style={styles.logoContainer}>
                    <Logo />
                </View>

                <Text className="text-foreground" style={styles.signInTitle}>Welcome to Mention</Text>
                <Text className="text-muted-foreground" style={styles.signInSubtitle}>
                    Join the conversation and connect with people who share your interests
                </Text>

                <View style={styles.featuresContainer}>
                    <View style={styles.featureItem}>
                        <Ionicons name="chatbubble-outline" size={20} color={theme.colors.primary} />
                        <Text className="text-foreground" style={styles.featureText}>Share your thoughts</Text>
                    </View>
                    <View style={styles.featureItem}>
                        <Ionicons name="people-outline" size={20} color={theme.colors.primary} />
                        <Text className="text-foreground" style={styles.featureText}>Connect with others</Text>
                    </View>
                    <View style={styles.featureItem}>
                        <Ionicons name="heart-outline" size={20} color={theme.colors.primary} />
                        <Text className="text-foreground" style={styles.featureText}>Discover new ideas</Text>
                    </View>
                </View>

                <TouchableOpacity className="bg-primary" style={styles.signInButton} onPress={handleSignInPress}>
                    <Text className="text-primary-foreground" style={styles.signInButtonText}>Get Started</Text>
                    <Ionicons name="arrow-forward" size={18} color={theme.colors.card} />
                </TouchableOpacity>

                <Text className="text-muted-foreground" style={styles.signInFooter}>
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
    },
    signInCard: {
        borderRadius: 20,
        padding: 32,
        width: '100%',
        maxWidth: 400,
        alignItems: 'center',
        boxShadow: '0px 4px 12px 0px rgba(0, 0, 0, 0.1)',
        elevation: 8,
    },
    logoContainer: {
        marginBottom: 24,
    },
    signInTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        marginBottom: 12,
        textAlign: 'center',
    },
    signInSubtitle: {
        fontSize: 16,
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
        marginLeft: 12,
        flex: 1,
    },
    signInButton: {
        paddingHorizontal: 32,
        paddingVertical: 16,
        borderRadius: 12,
        minWidth: 160,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        boxShadow: '0px 4px 8px 0px rgba(0, 92, 103, 0.3)',
        elevation: 6,
    },
    signInButtonText: {
        fontSize: 16,
        fontWeight: '600',
        marginRight: 8,
    },
    signInFooter: {
        fontSize: 12,
        textAlign: 'center',
        marginTop: 24,
        lineHeight: 18,
    },
});

export default SignInPrompt;
