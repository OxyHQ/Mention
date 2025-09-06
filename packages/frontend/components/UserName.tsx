import React from 'react';
import { Text, TouchableOpacity, StyleSheet, View, TextStyle } from 'react-native';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { colors } from '../styles/colors';

interface Props {
    name?: string | null;
    verified?: boolean;
    unifiedColors?: boolean; // if true, use unified colors for name and icon (e.g., dark mode)
    onPress?: () => void;
    variant?: 'default' | 'small';
    style?: {
        name?: TextStyle;
        container?: any;
    };
}

const UserName: React.FC<Props> = ({ name, verified, unifiedColors, onPress, variant = 'default', style }) => {
    const nameStyle = [styles.name, variant === 'small' && styles.nameSmall, style?.name];

    // Determine icon size from passed name fontSize (supports StyleSheet refs) so icon matches text size.
    const flattenedNameStyle = style?.name ? (StyleSheet.flatten(style.name) as TextStyle) : undefined;
    const passedFontSize = flattenedNameStyle?.fontSize;
    const effectiveFontSize = passedFontSize ?? (variant === 'small' ? 14 : 15);
    // Use the same size as the font so badge matches text size (profile header requirement)
    const iconSize = Math.round(effectiveFontSize);
    // Small positive translateY to nudge the icon downward to align with text baseline.
    // Use a slightly larger nudge for larger fonts (e.g., header titles) to improve visual alignment.
    const baselineNudge = Math.round(effectiveFontSize >= 18 ? effectiveFontSize * 0.18 : effectiveFontSize * 0.06);

    const content = (
        <View style={[styles.container, style?.container]}>
            <View style={styles.nameRow}>
                <Text style={nameStyle} numberOfLines={1} ellipsizeMode="tail">
                    {name}
                </Text>
                {verified && (
                    <VerifiedIcon size={iconSize} color={unifiedColors ? colors.COLOR_BLACK : colors.primaryColor} style={[styles.verifiedIcon, { transform: [{ translateY: baselineNudge }] }]} />
                )}
            </View>
        </View>
    );

    if (onPress) {
        return (
            <TouchableOpacity activeOpacity={0.7} onPress={onPress}>
                {content}
            </TouchableOpacity>
        );
    }

    return content;
};

export default UserName;

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    name: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.COLOR_BLACK,
    },
    nameSmall: {
        fontSize: 14,
        fontWeight: '700',
    },
    verifiedIcon: {
        marginLeft: 4,
    },
});
