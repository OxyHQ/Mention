import React from 'react';
import { View, Text, Platform } from 'react-native';
import { Pressable } from 'react-native-web-hover';
import { useRouter } from 'expo-router';
import { cn } from '@/lib/utils';

export function SideBarItem({
    isActive,
    icon,
    text,
    href,
    isExpanded,
    onHoverExpand,
    onPress,
}: {
    isActive: boolean;
    icon: React.ReactNode;
    text: string;
    href?: string;
    isExpanded: boolean;
    onHoverExpand?: () => void;
    onPress?: () => void;
}) {
    const router = useRouter();
    const [isHovered, setIsHovered] = React.useState(false);
    return (
        <Pressable
            {...({
                onPress: () => {
                    if (onPress) return onPress();
                    if (href) router.push(href);
                },
                onHoverIn: () => {
                    setIsHovered(true);
                    onHoverExpand?.();
                },
                onHoverOut: () => setIsHovered(false),
            } as any)}
            className={cn(
                "flex-row items-center rounded-[35px] py-2.5 mb-1.5",
                isExpanded ? "w-full self-stretch px-4" : "self-end px-3",
                isActive && "bg-primary/10",
                isHovered && !isActive && "bg-primary/5",
            )}
            style={({ pressed }: { pressed: boolean }) => [
                pressed ? { backgroundColor: 'hsla(var(--primary), 0.13)' } : {},
                Platform.select({
                    web: {
                        transition: 'all 200ms cubic-bezier(0.2, 0, 0, 1)',
                        willChange: 'background-color, border-color, transform',
                        cursor: 'pointer',
                    },
                }),
            ]}
        >
            <View className={cn(
                "flex-row items-center w-full justify-start",
                isExpanded ? "gap-3" : "gap-0",
            )}>
                <View
                    className={cn(
                        "items-center justify-center w-6 h-6",
                        isActive || isHovered ? "text-primary" : "text-foreground",
                    )}
                    style={Platform.select({
                        web: {
                            transition: 'color 200ms cubic-bezier(0.2, 0, 0, 1)',
                        },
                    })}
                >
                    {icon}
                </View>
                {isExpanded ? (
                    <Text
                        className={cn(
                            "text-[15px] whitespace-nowrap",
                            isActive ? "font-semibold" : "font-medium",
                            isActive || isHovered ? "text-primary" : "text-foreground",
                        )}
                        style={Platform.select({
                            web: {
                                transition: 'color 200ms cubic-bezier(0.2, 0, 0, 1)',
                            },
                        })}
                    >
                        {text}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
}
