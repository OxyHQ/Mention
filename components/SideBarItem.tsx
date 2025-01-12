import React from 'react'
import { View, Text, Platform } from 'react-native'
import { Pressable } from 'react-native-web-hover'
import { useMediaQuery } from 'react-responsive'
import { colors } from '@/styles/colors'

import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";

export function SideBarItem({
    isActive,
    icon,
    text,
    href,
}: {
    isActive: boolean;
    icon: React.ReactNode;
    text: string;
    href: string;
}) {
    const isFullSideBar = useMediaQuery({ minWidth: 1266 })
    return (
        <Pressable
            style={({ pressed, hovered }) => [
                hovered ? { backgroundColor: `${colors.primaryColor}33`, } : {},
                {
                    flexDirection: 'row',
                    alignItems: 'center',
                    width: 'fit-content',
                    marginBottom: 10,
                    marginEnd: isFullSideBar ? 70 : 0,
                    borderRadius: 100,
                    padding: 12,
                    paddingEnd: isFullSideBar ? 30 : 15,
                    ...Platform.select({
                        web: {
                            cursor: 'pointer',
                        },
                    }),
                    // borderWidth: 0.2,
                },
            ]}>
            <Link href={href as any} asChild>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {icon}
                    {isFullSideBar ? (
                        <Text style={{ marginStart: 20, fontSize: 20, color: isActive ? colors.primaryColor : colors.COLOR_BLACK }}>
                            {text}
                        </Text>
                    ) : null}
                </View>
            </Link>
        </Pressable>
    )
}