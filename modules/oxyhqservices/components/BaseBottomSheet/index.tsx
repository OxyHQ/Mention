import React, { ReactNode } from 'react';
import { View, TouchableOpacity, StyleSheet, Animated, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import { OxyLogo } from '../OxyLogo';
import { ThemedText } from '@/components/ThemedText';

const { width } = Dimensions.get('window');

interface BaseBottomSheetProps {
    children: ReactNode;
    title?: string;
    showLogo?: boolean;
    onClose: () => void;
    showBackButton?: boolean;
    onBack?: () => void;
    rightComponent?: ReactNode;
    contentStyle?: any;
}

export function BaseBottomSheet({
    children,
    title,
    showLogo = true,
    onClose,
    showBackButton,
    onBack,
    rightComponent,
    contentStyle,
}: BaseBottomSheetProps) {
    return (
        <View style={styles.container}>
            <LinearGradient
                colors={[colors.primaryLight, colors.primaryLight_1]}
                style={styles.gradientBackground}
            >
                <View style={styles.header}>
                    <View style={styles.headerLeft}>
                        {showBackButton ? (
                            <TouchableOpacity
                                onPress={onBack}
                                style={styles.closeButton}
                            >
                                <Ionicons name="arrow-back" size={24} color={colors.primaryColor} />
                            </TouchableOpacity>
                        ) : (
                            <TouchableOpacity
                                onPress={onClose}
                                style={styles.closeButton}
                            >
                                <Ionicons name="close" size={24} color={colors.primaryColor} />
                            </TouchableOpacity>
                        )}
                    </View>
                    <View style={styles.headerCenter}>
                        {showLogo ? (
                            <OxyLogo size={53} style={styles.logo} />
                        ) : title ? (
                            <ThemedText style={styles.title}>{title}</ThemedText>
                        ) : null}
                    </View>
                    <View style={styles.headerRight}>
                        {rightComponent}
                    </View>
                </View>
                <View style={[styles.content, contentStyle]}>
                    {children}
                </View>
            </LinearGradient>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.primaryLight,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        maxHeight: '90%',
        minHeight: 500,
        overflow: 'hidden',
    },
    gradientBackground: {
        flex: 1,
        padding: 16,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
        paddingHorizontal: 8,
        height: 48,
    },
    headerLeft: {
        flex: 1,
        alignItems: 'flex-start',
    },
    headerCenter: {
        flex: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerRight: {
        flex: 1,
        alignItems: 'flex-end',
    },
    closeButton: {
        padding: 8,
        borderRadius: 20,
        backgroundColor: colors.primaryLight_1,
    },
    logo: {
        opacity: 0.9,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.COLOR_BLACK,
    },
    content: {
        flex: 1,
        width: '100%',
    },
}); 