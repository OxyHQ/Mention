import React, { useCallback } from 'react';
import { Text, TouchableOpacity, StyleSheet, View, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { AgentIcon } from '@/assets/icons/agent-icon';
import { AutomatedIcon } from '@/assets/icons/automated-icon';
import type { UserNameProps } from '@/components/Profile/types';

const UserName: React.FC<UserNameProps> = ({ name, handle, verified, isFederated, isAgent, isAutomated, unifiedColors, onPress, variant = 'default', style }) => {
    const theme = useTheme();
    const nameStyle = [styles.name, variant === 'small' && styles.nameSmall, style?.name];

    const handleCopyHandle = useCallback(async () => {
        if (!handle) return;
        const text = `@${handle}`;
        await Clipboard.setStringAsync(text);
        toast('Copied to clipboard', { type: 'success' });
    }, [handle]);

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
                <Text className="text-foreground" style={nameStyle} numberOfLines={1} ellipsizeMode="tail">
                    {name}
                </Text>
                {verified && (
                    <VerifiedIcon size={iconSize} className={unifiedColors ? "text-foreground" : "text-primary"} style={[styles.badgeIcon, { transform: [{ translateY: baselineNudge }] }]} />
                )}
                {isFederated && (
                    <FediverseIcon size={iconSize} color={theme.colors.text} style={[styles.badgeIcon, { transform: [{ translateY: baselineNudge }] }]} />
                )}
                {isAgent && (
                    <AgentIcon size={iconSize} className="text-muted-foreground" style={[styles.badgeIcon, { transform: [{ translateY: baselineNudge }] }]} />
                )}
                {isAutomated && (
                    <AutomatedIcon size={iconSize} className="text-muted-foreground" style={[styles.badgeIcon, { transform: [{ translateY: baselineNudge }] }]} />
                )}
            </View>
            {handle ? (
                isFederated ? (
                    <TouchableOpacity activeOpacity={0.7} onPress={handleCopyHandle}>
                        <Text className="text-muted-foreground" style={[styles.handle, style?.handle]} numberOfLines={1} ellipsizeMode="tail">
                            @{handle}
                        </Text>
                    </TouchableOpacity>
                ) : (
                    <Text className="text-muted-foreground" style={[styles.handle, style?.handle]} numberOfLines={1} ellipsizeMode="tail">
                        @{handle}
                    </Text>
                )
            ) : null}
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


const styles = StyleSheet.create({
    container: {
        flexDirection: 'column',
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    name: {
        fontSize: 15,
        fontWeight: '700',
    },
    nameSmall: {
        fontSize: 14,
        fontWeight: '700',
    },
    handle: {
        fontSize: 15,
        lineHeight: 20,
    },
    badgeIcon: {
        marginLeft: 4,
    },
});

export default React.memo(UserName);
