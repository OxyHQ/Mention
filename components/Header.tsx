import React from 'react'
import {
    StyleSheet,
    View,
    Text,
    ViewStyle,
    Platform,
} from 'react-native'
import { Pressable } from 'react-native'
import { Ionicons } from "@expo/vector-icons";
import { colors } from '@/styles/colors'
import { useRouter } from 'expo-router'
import { ReactNode } from 'react'

interface Props {
    style?: ViewStyle
    options?: {
        title?: string
        titlePosition?: 'left' | 'center' // Add titlePosition option
        showBackButton?: boolean
        leftComponents?: ReactNode[]
        rightComponents?: ReactNode[]
    }
}

export const Header: React.FC<Props> = ({ options }) => {
    const router = useRouter();

    const titlePosition = options?.titlePosition || 'left'; // Default title position to left

    return (
        <View style={styles.topRow}>
            <View style={styles.leftContainer}>
                {options?.showBackButton && (
                    <Pressable onPress={() => router.back()} style={styles.backButton}>
                        <Ionicons name="arrow-back" size={24} color={colors.COLOR_BLACK} />
                    </Pressable>
                )}
                {options?.leftComponents?.map((component, index) => (
                    <React.Fragment key={index}>{component}</React.Fragment>
                ))}
                {options?.title && titlePosition === 'left' && (
                    <Text style={styles.topRowText}>{options.title}</Text>
                )}
            </View>
            {options?.title && titlePosition === 'center' && (
                <View style={styles.centerContainer}>
                    <Text style={styles.topRowText}>{options.title}</Text>
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
    },
})
