import React, { memo, useState, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ViewStyle, TextStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { flattenStyleArray } from '@/utils/theme';
import { Ionicons } from '@expo/vector-icons';

export interface EmptyStateProps {
    title?: string;
    subtitle?: string;
    icon?: {
        name: keyof typeof Ionicons.glyphMap;
        size?: number;
        color?: string;
        backgroundColor?: string;
    };
    error?: {
        title: string;
        message: string;
        onRetry?: () => Promise<void>;
    };
    action?: {
        label: string;
        onPress: () => void;
        icon?: keyof typeof Ionicons.glyphMap;
    };
    customIcon?: ReactNode;
    style?: ViewStyle;
    containerStyle?: ViewStyle;
    titleStyle?: TextStyle;
    subtitleStyle?: TextStyle;
    accessible?: boolean;
    accessibilityLabel?: string;
}

/**
 * Reusable empty state component
 * Handles simple empty states, error states with retry, and states with action buttons
 */
export const EmptyState = memo<EmptyStateProps>(
    ({
        title,
        subtitle,
        icon,
        error,
        action,
        customIcon,
        style,
        containerStyle,
        titleStyle,
        subtitleStyle,
        accessible = true,
        accessibilityLabel,
    }) => {
        const theme = useTheme();
        const [isRetrying, setIsRetrying] = useState(false);

        const handleRetry = async () => {
            if (!error?.onRetry || isRetrying) return;
            setIsRetrying(true);
            try {
                await error.onRetry();
            } finally {
                setIsRetrying(false);
            }
        };

        // Error state with retry
        if (error) {
            return (
                <View
                    style={flattenStyleArray([
                        styles.errorContainer,
                        { backgroundColor: theme.colors.background },
                        containerStyle,
                    ])}
                >
                    <View style={styles.errorContent}>
                        {icon && (
                            <View
                                style={[
                                    styles.iconWrapper,
                                    {
                                        backgroundColor: icon.backgroundColor || theme.colors.error + '15',
                                    },
                                ]}
                            >
                                <Ionicons
                                    name={icon.name}
                                    size={icon.size || 36}
                                    color={icon.color || theme.colors.error}
                                />
                            </View>
                        )}

                        <Text
                            style={flattenStyleArray([
                                styles.errorTitle,
                                { color: theme.colors.text },
                                titleStyle,
                            ])}
                        >
                            {error.title}
                        </Text>

                        <Text
                            style={flattenStyleArray([
                                styles.errorMessage,
                                { color: theme.colors.textSecondary },
                                subtitleStyle,
                            ])}
                        >
                            {error.message}
                        </Text>

                        {error.onRetry && (
                            <TouchableOpacity
                                style={[
                                    styles.retryButton,
                                    {
                                        backgroundColor: theme.colors.primary,
                                        opacity: isRetrying ? 0.6 : 1,
                                    },
                                ]}
                                onPress={handleRetry}
                                disabled={isRetrying}
                                activeOpacity={0.8}
                            >
                                {isRetrying ? (
                                    <ActivityIndicator
                                        size="small"
                                        color={theme.colors.card}
                                    />
                                ) : (
                                    <>
                                        <Ionicons
                                            name="refresh"
                                            size={18}
                                            color={theme.colors.card}
                                            style={styles.retryIcon}
                                        />
                                        <Text
                                            style={[
                                                styles.retryButtonText,
                                                { color: theme.colors.card },
                                            ]}
                                        >
                                            Try again
                                        </Text>
                                    </>
                                )}
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }

        // Regular empty state
        if (!title && !subtitle && !customIcon && !icon) {
            return null;
        }

        return (
            <View
                style={flattenStyleArray([
                    styles.emptyState,
                    { backgroundColor: theme.colors.background },
                    containerStyle,
                ])}
                accessible={accessible}
                accessibilityRole="text"
                accessibilityLabel={accessibilityLabel || `${title || ''}. ${subtitle || ''}`}
            >
                {customIcon && <View style={styles.iconContainer}>{customIcon}</View>}
                
                {icon && !customIcon && (
                    <View
                        style={[
                            styles.iconWrapper,
                            icon.backgroundColor && {
                                backgroundColor: icon.backgroundColor,
                            },
                        ]}
                    >
                        <Ionicons
                            name={icon.name}
                            size={icon.size || 48}
                            color={icon.color || theme.colors.textSecondary}
                        />
                    </View>
                )}

                {title && (
                    <Text
                        style={flattenStyleArray([
                            styles.emptyStateText,
                            { color: theme.colors.text },
                            titleStyle,
                        ])}
                    >
                        {title}
                    </Text>
                )}

                {subtitle && (
                    <Text
                        style={flattenStyleArray([
                            styles.emptyStateSubtext,
                            { color: theme.colors.textSecondary },
                            subtitleStyle,
                        ])}
                    >
                        {subtitle}
                    </Text>
                )}

                {action && (
                    <TouchableOpacity
                        style={[
                            styles.actionButton,
                            { backgroundColor: theme.colors.primary },
                        ]}
                        onPress={action.onPress}
                        activeOpacity={0.8}
                    >
                        {action.icon && (
                            <Ionicons
                                name={action.icon}
                                size={18}
                                color={theme.colors.card}
                                style={styles.actionIcon}
                            />
                        )}
                        <Text
                            style={[
                                styles.actionButtonText,
                                { color: theme.colors.card },
                            ]}
                        >
                            {action.label}
                        </Text>
                    </TouchableOpacity>
                )}
            </View>
        );
    }
);

EmptyState.displayName = 'EmptyState';

const styles = StyleSheet.create({
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 32,
        paddingHorizontal: 24,
    },
    errorContent: {
        alignItems: 'center',
        maxWidth: 320,
        width: '100%',
    },
    iconWrapper: {
        width: 72,
        height: 72,
        borderRadius: 36,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 12,
    },
    iconContainer: {
        marginBottom: 12,
    },
    errorTitle: {
        fontSize: 18,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 6,
        letterSpacing: -0.3,
    },
    errorMessage: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: 16,
    },
    retryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        minWidth: 100,
        gap: 6,
    },
    retryIcon: {
        marginRight: 0,
    },
    retryButtonText: {
        fontSize: 15,
        fontWeight: '600',
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 32,
        paddingHorizontal: 24,
    },
    emptyStateText: {
        fontSize: 18,
        fontWeight: '700',
        marginTop: 12,
        textAlign: 'center',
        letterSpacing: -0.5,
    },
    emptyStateSubtext: {
        fontSize: 14,
        marginTop: 6,
        textAlign: 'center',
        lineHeight: 20,
        maxWidth: 280,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        marginTop: 18,
        gap: 6,
    },
    actionIcon: {
        marginRight: 0,
    },
    actionButtonText: {
        fontSize: 15,
        fontWeight: '600',
    },
});

