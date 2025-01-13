import React from 'react'
import { View, Text, Platform, Pressable } from 'react-native'
import { useMediaQuery } from 'react-responsive'
import { useRouter } from 'expo-router';
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
    const router = useRouter();
    const isFullSideBar = useMediaQuery({ minWidth: 1266 })
    return (
        <Pressable
            onPress={() => router.push(href)}
            style={({ pressed, hovered }) => [
                pressed ? { backgroundColor: `${colors.primaryColor}33`, } : {},
                hovered ? { backgroundColor: `${colors.primaryColor}22`, } : {},
                {
                    flexDirection: 'row',
                    alignItems: 'center',
                    width: 'auto',
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
                },
            ]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {icon}
                {isFullSideBar ? (
                    <Text style={{ marginStart: 20, fontSize: 20, color: isActive ? colors.primaryColor : colors.COLOR_BLACK }}>
                        {text}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    )
}