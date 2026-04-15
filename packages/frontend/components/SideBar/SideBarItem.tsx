import React, { useCallback } from 'react';
import { View, Text, Platform, Pressable, type ViewStyle, type TextStyle } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { cn } from '@/lib/utils';

const WEB_BG_TRANSITION: ViewStyle | undefined = Platform.OS === 'web'
    ? ({
        transition: 'background-color 200ms cubic-bezier(0.2, 0, 0, 1)',
        cursor: 'pointer',
    } as ViewStyle)
    : undefined;

const WEB_COLOR_TRANSITION_VIEW: ViewStyle | undefined = Platform.OS === 'web'
    ? ({
        transition: 'color 200ms cubic-bezier(0.2, 0, 0, 1)',
    } as ViewStyle)
    : undefined;

const WEB_COLOR_TRANSITION_TEXT: TextStyle | undefined = Platform.OS === 'web'
    ? ({
        transition: 'color 200ms cubic-bezier(0.2, 0, 0, 1)',
    } as TextStyle)
    : undefined;

export const SideBarItem = React.memo(function SideBarItem({
    isActive,
    icon,
    text,
    href,
    isExpanded = false,
    onPress,
}: {
    isActive: boolean;
    icon: React.ReactNode;
    text: string;
    href?: Href;
    isExpanded?: boolean;
    onPress?: () => void;
}) {
    const router = useRouter();
    const [isHovered, setIsHovered] = React.useState(false);

    const handlePress = useCallback(() => {
        if (onPress) return onPress();
        if (href) router.push(href);
    }, [onPress, href, router]);

    const handleHoverIn = useCallback(() => setIsHovered(true), []);
    const handleHoverOut = useCallback(() => setIsHovered(false), []);

    return (
        <Pressable
            onPress={handlePress}
            onHoverIn={handleHoverIn}
            onHoverOut={handleHoverOut}
            className={cn(
                "flex-row items-center rounded-[35px] py-2.5 mb-1.5",
                isExpanded ? "w-full self-stretch px-4" : "self-center px-3",
                isActive && "bg-primary/10",
                isHovered && !isActive && "bg-primary/5",
            )}
            style={({ pressed }: { pressed: boolean }) => [
                pressed ? { backgroundColor: 'hsla(var(--primary), 0.13)' } : null,
                WEB_BG_TRANSITION,
            ]}
        >
            <View className={cn(
                "flex-row items-center w-full",
                isExpanded ? "justify-start gap-3" : "justify-center gap-0",
            )}>
                <View
                    className={cn(
                        "items-center justify-center w-6 h-6",
                        isActive || isHovered ? "text-primary" : "text-foreground",
                    )}
                    style={WEB_COLOR_TRANSITION_VIEW}
                >
                    {icon}
                </View>
                {isExpanded && (
                    <Text
                        className={cn(
                            "text-[15px] whitespace-nowrap",
                            isActive ? "font-semibold" : "font-medium",
                            isActive || isHovered ? "text-primary" : "text-foreground",
                        )}
                        style={WEB_COLOR_TRANSITION_TEXT}
                    >
                        {text}
                    </Text>
                )}
            </View>
        </Pressable>
    );
});
