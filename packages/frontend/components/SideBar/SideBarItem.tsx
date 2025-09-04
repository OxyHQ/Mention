import React from 'react';
import { View, Text, Platform } from 'react-native';
import { Pressable } from 'react-native-web-hover';
import { useRouter } from 'expo-router';
import { colors } from '@/styles/colors';

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
            style={({ pressed }) => [
                {
                    flexDirection: 'row',
                    alignItems: 'center',
                    width: isExpanded ? '100%' : 'auto',
                    alignSelf: isExpanded ? 'stretch' : 'flex-start',
                    marginBottom: 6,
                    marginEnd: 0,
                    borderRadius: 35,
                    paddingVertical: 10,
                    paddingHorizontal: isExpanded ? 16 : 12,
                    marginLeft: 0,
                    backgroundColor: pressed
                        ? `${colors.primaryColor}20`
                        : isHovered
                            ? `${colors.primaryColor}0F`
                            : isActive
                                ? `${colors.primaryColor}15`
                                : 'transparent',
                    ...(Platform.select({
                        web: {
                            transition: 'all 200ms cubic-bezier(0.2, 0, 0, 1)',
                            willChange: 'background-color, border-color, transform',
                        },
                    }) as any),
                    ...Platform.select({
                        web: {
                            cursor: 'pointer',
                        },
                    }),
                },
            ]}
        >
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                width: '100%',
                justifyContent: 'flex-start',
                gap: isExpanded ? 12 : 0,
            }}>
                <View style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                }}>
                    {icon}
                </View>
                {isExpanded ? (
                    <Text
                        style={{
                            fontSize: 15,
                            fontWeight: isActive ? '600' : '500',
                            color: isActive || isHovered ? colors.primaryColor : colors.COLOR_BLACK,
                            ...(Platform.select({
                                web: {
                                    transition: 'color 200ms cubic-bezier(0.2, 0, 0, 1)',
                                    fontFamily: 'Phudu',
                                    whiteSpace: 'nowrap',
                                },
                            }) as any),
                        }}
                    >
                        {text}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
}
