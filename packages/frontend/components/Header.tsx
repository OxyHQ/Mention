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
import { useRouter } from "expo-router"
import { ReactNode } from "react"
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface Props {
    style?: ViewStyle
    options?: {
        title?: string
        titlePosition?: 'left' | 'center'
        subtitle?: string | ReactNode
        showBackButton?: boolean
        leftComponents?: ReactNode[]
        rightComponents?: ReactNode[]
        headerTitleStyle?: ViewStyle
    }
    hideBottomBorder?: boolean
    disableSticky?: boolean
}

export const Header: React.FC<Props> = ({ options, hideBottomBorder = false, disableSticky = false }) => {
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
        hideBottomBorder ? { borderBottomWidth: 0 } : {},
        disableSticky && Platform.OS === 'web' ? { position: 'relative' as const } : {},
    ];

    return (
        <View
            className={cn(
                "bg-background",
                !hideBottomBorder && "border-border",
            )}
            style={headerStyle}>
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
                    <View style={[options?.headerTitleStyle, { flex: 1 }]}>
                        {options?.title && (
                            <Text className="text-foreground" style={[styles.topRowText, options?.subtitle && { fontSize: 16 }]}>
                                {options.title}
                            </Text>
                        )}
                        {options?.subtitle && (typeof options.subtitle === 'string' ? (
                            <Text className="text-muted-foreground" style={{ fontSize: 13 }}>
                                {options.subtitle}
                            </Text>
                        ) : (
                            <View style={{ marginTop: 2 }}>
                                {options.subtitle}
                            </View>
                        ))}
                    </View>
                )}

            </View>
            {titlePosition === "center" && (
                <View style={styles.centerContainer}>
                    {options?.title && (
                        <Text className="text-foreground" style={[styles.topRowText, options?.subtitle && { fontSize: 14 }]}>
                            {options.title}
                        </Text>
                    )}
                    {options?.subtitle && (typeof options.subtitle === 'string' ? (
                        <Text className="text-muted-foreground">{options.subtitle}</Text>
                    ) : (
                        options.subtitle
                    ))}
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
        minHeight: 48,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottomWidth: 0.01,
        paddingHorizontal: 16,
        paddingVertical: 8,
        position: "relative",
        ...Platform.select({
            web: {
                position: "sticky",
            },
        }),
        top: 0,
        zIndex: 100,
    } as ViewStyle,
    topRowText: {
        fontSize: 18,
        fontWeight: "800",
        paddingStart: 0,
    },
    startContainer: {
        borderRadius: 100,
        padding: 10,
    },
    backButton: {
        marginRight: 8,
    },
    leftContainer: {
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
        gap: 8,
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
        gap: 8,
    },
    stickyHeader: {
        borderTopEndRadius: 0,
        borderTopStartRadius: 0,
    },
})
