import React, { memo, useState, ReactNode } from 'react';
import { View, Text, TouchableOpacity, ViewStyle, TextStyle } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
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
                        containerStyle,
                    ])}
                    className="flex-1 justify-center items-center py-8 px-6 bg-background"
                >
                    <View className="items-center max-w-[320px] w-full">
                        {icon && (
                            <View
                                className="w-[72px] h-[72px] rounded-full justify-center items-center mb-3"
                                style={{
                                    backgroundColor: icon.backgroundColor || theme.colors.error + '15',
                                }}
                            >
                                <Ionicons
                                    name={icon.name}
                                    size={icon.size || 36}
                                    color={icon.color || theme.colors.error}
                                />
                            </View>
                        )}

                        <Text
                            className="text-lg font-bold text-center text-foreground mb-1.5"
                            style={{ letterSpacing: -0.3, ...flattenStyleArray([titleStyle]) }}
                        >
                            {error.title}
                        </Text>

                        <Text
                            className="text-sm text-center text-muted-foreground mb-4"
                            style={{ lineHeight: 20, ...flattenStyleArray([subtitleStyle]) }}
                        >
                            {error.message}
                        </Text>

                        {error.onRetry && (
                            <TouchableOpacity
                                className="flex-row items-center justify-center py-2 px-4 rounded-[20px] min-w-[100px] gap-1.5 bg-primary"
                                style={{ opacity: isRetrying ? 0.6 : 1 }}
                                onPress={handleRetry}
                                disabled={isRetrying}
                                activeOpacity={0.8}
                            >
                                {isRetrying ? (
                                    <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                                ) : (
                                    <>
                                        <Ionicons
                                            name="refresh"
                                            size={18}
                                            color={theme.colors.card}
                                        />
                                        <Text
                                            className="text-[15px] font-semibold"
                                            style={{ color: theme.colors.card }}
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
                    containerStyle,
                ])}
                className="flex-1 justify-center items-center py-8 px-6 bg-background"
                accessible={accessible}
                accessibilityRole="text"
                accessibilityLabel={accessibilityLabel || [title, subtitle].filter(Boolean).join('. ')}
            >
                {customIcon && <View className="mb-3">{customIcon}</View>}

                {icon && !customIcon && (
                    <View
                        className="w-[72px] h-[72px] rounded-full justify-center items-center mb-3"
                        style={icon.backgroundColor ? { backgroundColor: icon.backgroundColor } : undefined}
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
                        className="text-lg font-bold mt-3 text-center text-foreground"
                        style={{ letterSpacing: -0.5, ...flattenStyleArray([titleStyle]) }}
                    >
                        {title}
                    </Text>
                )}

                {subtitle && (
                    <Text
                        className="text-sm mt-1.5 text-center text-muted-foreground max-w-[280px]"
                        style={{ lineHeight: 20, ...flattenStyleArray([subtitleStyle]) }}
                    >
                        {subtitle}
                    </Text>
                )}

                {action && (
                    <TouchableOpacity
                        className="flex-row items-center justify-center py-2 px-4 rounded-[20px] mt-4.5 gap-1.5 bg-primary"
                        onPress={action.onPress}
                        activeOpacity={0.8}
                    >
                        {action.icon && (
                            <Ionicons
                                name={action.icon}
                                size={18}
                                color={theme.colors.card}
                            />
                        )}
                        <Text
                            className="text-[15px] font-semibold"
                            style={{ color: theme.colors.card }}
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
