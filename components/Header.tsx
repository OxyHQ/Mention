import React from 'react'
import {
    StyleSheet,
    Image,
    View,
    Text,
    ViewStyle,
    TextInput,
    Platform,
} from 'react-native'
import { Pressable } from 'react-native-web-hover'
import { Ionicons } from "@expo/vector-icons";
import { colors } from '@/styles/colors'
import { useState } from 'react'

interface Props {
    style?: ViewStyle
}

export const Header: React.FC<Props> = ({ }) => {
    return (
        <View style={styles.topRow}>
            <Text style={styles.topRowText}>Home</Text>

            <Pressable
                style={({ hovered }) => [
                    styles.startContainer,
                    hovered
                        ? {
                            backgroundColor: colors.COLOR_BLACK_LIGHT_6,
                        }
                        : {},
                ]}>
                <Ionicons name="star" size={18} />
            </Pressable>
        </View>
    )
}


const styles = StyleSheet.create({
    container: {
        width: '100%',
        paddingBottom: 10,
    },
    topRow: {
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
})
