import React, { useEffect, useState } from "react";
import {
    StyleSheet,
    View,
    Text,
    ViewStyle,
    Platform,
} from "react-native"
import { Pressable } from "react-native"
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/styles/colors"
import { useRouter } from "expo-router"
import { ReactNode } from "react"
import { useTheme } from "@/hooks/useTheme";

interface Props {
    style?: ViewStyle
    options?: {
        title?: string
        titlePosition?: 'left' | 'center'
        subtitle?: string
        showBackButton?: boolean
        leftComponents?: ReactNode[]
        rightComponents?: ReactNode[]
    }
    hideBottomBorder?: boolean
}

export const Header: React.FC<Props> = ({ options, hideBottomBorder = false }) => {
    const router = useRouter();
    const [isSticky, setIsSticky] = useState(false);
    const theme = useTheme();

    const titlePosition = options?.titlePosition || "left";

    useEffect(() => {
        if (Platform.OS === 'web') {
            const handleScroll = () => {
                if (window.scrollY > 20) {
                    setIsSticky(true);
                } else {
                    setIsSticky(false);
                }
            };

            window.addEventListener('scroll', handleScroll);
            return () => {
                window.removeEventListener('scroll', handleScroll);
            };
        }
    }, []);

    const headerStyle = [
        styles.topRow,
        isSticky && styles.stickyHeader,
        { backgroundColor: theme.colors.background },
        hideBottomBorder ? { borderBottomWidth: 0 } : { borderBottomColor: theme.colors.border }
    ];

    return (
        <View style={headerStyle}>
            <View style={styles.leftContainer}>
                {options?.showBackButton && (
                    <Pressable onPress={() => router.back()} style={styles.backButton}>
                        <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
                    </Pressable>
                )}
                {options?.leftComponents?.map((component, index) => (
                    <React.Fragment key={index}>{component}</React.Fragment>
                ))}
                {titlePosition === "left" && (
                    <View>
                        {options?.title && (
                            <Text style={[styles.topRowText, options?.subtitle && { fontSize: 14 }, { color: theme.colors.text }]}>
                                {options.title}
                            </Text>
                        )}
                        {options?.subtitle && <Text style={{ color: theme.colors.textSecondary }}>{options.subtitle}</Text>}
                    </View>
                )}

            </View>
            {titlePosition === "center" && (
                <View style={styles.centerContainer}>
                    {options?.title && (
                        <Text style={[styles.topRowText, options?.subtitle && { fontSize: 14 }, { color: theme.colors.text }]}>
                            {options.title}
                        </Text>
                    )}
                    {options?.subtitle && <Text style={{ color: theme.colors.textSecondary }}>{options.subtitle}</Text>}
                </View>
            )}
            <View style={styles.rightContainer}>
                {options?.rightComponents?.map((component, index) => (
                    <React.Fragment key={index}>{component}</React.Fragment>
                ))}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        width: "100%",
        paddingBottom: 10,
    },
    topRow: {
        minHeight: 60,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottomWidth: 0.01,
        paddingHorizontal: 15,
        // borderBottomColor and backgroundColor applied inline with theme
        paddingVertical: 5,
        position: "relative",
        ...Platform.select({
            web: {
                position: "sticky",
            },
        }),
        top: 0,
        // backgroundColor applied inline with theme
        zIndex: 100,
    } as ViewStyle,
    topRowText: {
        fontSize: 20,
        // color applied inline with theme
        fontWeight: "800",
        paddingStart: 1,
    },
    startContainer: {
        borderRadius: 100,
        padding: 10,
    },
    backButton: {
        marginRight: 10,
    },
    leftContainer: {
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
        gap: 10,
    },
    centerContainer: {
        flex: 1,
        alignItems: "center",
    },
    rightContainer: {
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
        justifyContent: "flex-end",
        gap: 10,
    },
    stickyHeader: {
        borderTopEndRadius: 0,
        borderTopStartRadius: 0,
    },
})
