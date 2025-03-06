import React, { useEffect, useState } from 'react';
import {
    StyleSheet,
    View,
    Text,
    ViewStyle,
    Platform,
} from 'react-native'
import { Pressable } from 'react-native'
import { Ionicons } from "@expo/vector-icons";
import { colors } from '../../styles/colors'
import { useRouter } from 'expo-router'
import { ReactNode } from 'react'

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
}

export const Header: React.FC<Props> = ({ options }) => {
    const router = useRouter();
    const [isSticky, setIsSticky] = useState(false);

    const titlePosition = options?.titlePosition || 'left';

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

    return (
        <View style={[styles.topRow, isSticky && styles.stickyHeader]}>
            <View style={styles.leftContainer}>
                {options?.showBackButton && (
                    <Pressable onPress={() => router.back()} style={styles.backButton}>
                        <Ionicons name="arrow-back" size={24} color={colors.COLOR_BLACK} />
                    </Pressable>
                )}
                {options?.leftComponents?.map((component, index) => (
                    <React.Fragment key={index}>{component}</React.Fragment>
                ))}
                {titlePosition === 'left' && (
                    <View>
                        {options?.title && (
                            <Text style={[styles.topRowText, options?.subtitle && { fontSize: 14 }]}>
                                {options.title}
                            </Text>
                        )}
                        {options?.subtitle && <Text>{options.subtitle}</Text>}
                    </View>
                )}

            </View>
            {titlePosition === 'center' && (
                <View style={styles.centerContainer}>
                    {options?.title && (
                        <Text style={[styles.topRowText, options?.subtitle && { fontSize: 14 }]}>
                            {options.title}
                        </Text>
                    )}
                    {options?.subtitle && <Text>{options.subtitle}</Text>}
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
        width: '100%',
        paddingBottom: 10,
    },
    topRow: {
        minHeight: 60,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottomWidth: 0.01,
        paddingHorizontal: 15,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        paddingVertical: 5,
        position: 'relative',
        ...Platform.select({
            web: {
                position: 'sticky',
            },
        }),
        top: 0,
        backgroundColor: colors.primaryLight,
        zIndex: 100,
        borderTopEndRadius: 35,
        borderTopStartRadius: 35,
    } as ViewStyle,
    topRowText: {
        fontSize: 20,
        color: colors.COLOR_BLACK,
        fontWeight: '800',
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
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        gap: 10,
    },
    centerContainer: {
        flex: 1,
        alignItems: 'center',
    },
    rightContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        justifyContent: 'flex-end',
        gap: 10,
    },
    stickyHeader: {
        borderTopEndRadius: 0,
        borderTopStartRadius: 0,
    },
})
