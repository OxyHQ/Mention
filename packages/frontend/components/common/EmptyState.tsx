import React, { memo, useState, ReactNode } from 'react';
import { View, Text, ViewStyle, TextStyle } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiRefreshLine } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { flattenStyleArray } from '@/styles/shared';
import Ionicons from '@expo/vector-icons/Ionicons';

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
                    className="flex-1 justify-center items-center py-8 px-6"
                >
                    <View className="items-center max-w-[320px] w-full">
                        {icon && (
                            <View
                                className="w-[72px] h-[72px] rounded-full justify-center items-center mb-3"
                                style={{
                                    // `error + '15'` only ever worked because that token is a flat hex.
                                    // Bloom colour tokens resolve to `rgb(...)`, where a hex
                                    // alpha tail is malformed and parses back as fully OPAQUE —
                                    // a solid red disc under a red icon. `negativeSubtle` is the
                                    // real tinted surface and needs no alpha maths.
                                    backgroundColor: icon.backgroundColor || theme.colors.negativeSubtle,
                                }}
                            >
                                <Ionicons
                                    name={icon.name}
                                    size={icon.size || 36}
                                    color={icon.color || theme.colors.negativeSubtleForeground}
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
                            <Button
                                // The retry action is a secondary moment, not the
                                // screen's brand statement.
                                variant="secondary"
                                leadingIcon={RiRefreshLine}
                                loading={isRetrying}
                                onPress={handleRetry}
                                className="min-w-[100px]"
                            >
                                Try again
                            </Button>
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
                className="flex-1 justify-center items-center py-8 px-6"
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
                    <Button
                        variant="primary"
                        icon={action.icon && (
                            <Ionicons
                                name={action.icon}
                                size={18}
                                color={theme.colors.primaryForeground}
                            />
                        )}
                        onPress={action.onPress}
                        className="mt-4.5"
                    >
                        {action.label}
                    </Button>
                )}
            </View>
        );
    }
);

EmptyState.displayName = 'EmptyState';
