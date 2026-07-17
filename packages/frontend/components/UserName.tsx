import React, { useCallback } from 'react';
import { Text, TouchableOpacity, StyleSheet, View, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { RemoteActorBadge } from '@/components/Fediverse/FediverseBadge';
import { AgentIcon } from '@/assets/icons/agent-icon';
import { AutomatedIcon } from '@/assets/icons/automated-icon';
import type { UserNameProps } from '@/components/Profile/types';

const UserName: React.FC<UserNameProps> = ({ name, handle, verified, isFederated, isAgent, isAutomated, unifiedColors, onPress, copyableHandle, variant = 'default', style, trailingBadge, handleTrailing }) => {
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

    // Single source of truth for the "display name else handle, once" rule:
    //  - a real display name owns the bold primary slot, with the muted `@handle`
    //    line trailing below (as before);
    //  - with NO display name the `@handle` takes the bold primary slot ONCE and
    //    the separate muted handle line is suppressed (never blank, never doubled);
    //  - with neither, nothing renders.
    const hasName = !!name?.trim();
    const primaryText = hasName ? name : (handle ? `@${handle}` : undefined);
    const showHandleLine = hasName && !!handle;

    // Handle line: the muted `@handle`, optionally with a passive inline element
    // (e.g. a "Follows you" tag) rendered to its right on the SAME line. When a
    // trailing element is present the handle is wrapped in a row and the caller's
    // bottom margin is relocated onto that row so the tag stays vertically
    // centered with the handle text; the handle itself shrinks first so it stays
    // primary. With no trailing element the original single-Text path is kept
    // byte-for-byte, so every other caller is unaffected.
    let handleLineNode: React.ReactNode = null;
    if (showHandleLine) {
        if (handleTrailing != null) {
            const flatHandle = StyleSheet.flatten([styles.handle, style?.handle]) as TextStyle;
            const { marginBottom: handleMarginBottom, ...handleTextStyle } = flatHandle;
            const handleText = (
                <Text
                    className="text-muted-foreground"
                    style={[handleTextStyle, styles.handleShrink]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                >
                    @{handle}
                </Text>
            );
            handleLineNode = (
                <View
                    className="gap-2"
                    style={[styles.handleTrailingRow, handleMarginBottom != null ? { marginBottom: handleMarginBottom } : null]}
                >
                    {isFederated && copyableHandle ? (
                        <TouchableOpacity activeOpacity={0.7} onPress={handleCopyHandle} style={styles.handleShrink}>
                            {handleText}
                        </TouchableOpacity>
                    ) : (
                        handleText
                    )}
                    {handleTrailing}
                </View>
            );
        } else if (isFederated && copyableHandle) {
            handleLineNode = (
                <TouchableOpacity activeOpacity={0.7} onPress={handleCopyHandle}>
                    <Text className="text-muted-foreground" style={[styles.handle, style?.handle]} numberOfLines={1} ellipsizeMode="tail">
                        @{handle}
                    </Text>
                </TouchableOpacity>
            );
        } else {
            handleLineNode = (
                <Text className="text-muted-foreground" style={[styles.handle, style?.handle]} numberOfLines={1} ellipsizeMode="tail">
                    @{handle}
                </Text>
            );
        }
    }

    const inner = (
        <>
            <View className="gap-1" style={styles.nameRow}>
                {primaryText != null && (
                    <Text className="text-foreground" style={nameStyle} numberOfLines={1} ellipsizeMode="tail">
                        {primaryText}
                    </Text>
                )}
                {verified && (
                    <VerifiedIcon size={iconSize} className={unifiedColors ? "text-foreground" : "text-primary"} style={{ transform: [{ translateY: baselineNudge }] }} />
                )}
                {isFederated && (
                    <RemoteActorBadge size={iconSize} color={theme.colors.text} style={{ transform: [{ translateY: baselineNudge }] }} />
                )}
                {isAgent && (
                    <AgentIcon size={iconSize} className="text-muted-foreground" style={{ transform: [{ translateY: baselineNudge }] }} />
                )}
                {isAutomated && (
                    <AutomatedIcon size={iconSize} className="text-muted-foreground" style={{ transform: [{ translateY: baselineNudge }] }} />
                )}
                {trailingBadge}
            </View>
            {handleLineNode}
        </>
    );

    if (onPress) {
        // The Touchable is the actual flex child in the caller's row, so the
        // caller's `container` style (e.g. PostHeader's `{ flexShrink: 0,
        // maxWidth: '70%' }`) lands on the Touchable — that is where the width
        // constraint must sit so truncation reaches the inner name Text. The
        // inner column carries ONLY `styles.container`, so a percentage
        // `maxWidth` is never applied twice (nested) and collapsed.
        return (
            <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={style?.container}>
                <View style={styles.container}>{inner}</View>
            </TouchableOpacity>
        );
    }

    return <View style={[styles.container, style?.container]}>{inner}</View>;
};


const styles = StyleSheet.create({
    container: {
        flexDirection: 'column',
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        // Allow the row to shrink below its content's intrinsic width when a
        // constraining parent requests it, so the name Text can ellipsize.
        minWidth: 0,
    },
    name: {
        fontSize: 15,
        fontWeight: '700',
        // Shrink (and ellipsize via numberOfLines=1) only when the parent
        // constrains width; a no-op when there is room, so unconstrained
        // callers keep the name's intrinsic width.
        flexShrink: 1,
    },
    nameSmall: {
        fontSize: 14,
        fontWeight: '700',
    },
    handle: {
        fontSize: 15,
        lineHeight: 20,
    },
    // Row that holds the `@handle` plus an inline trailing tag; the handle keeps
    // the flexible space and shrinks first so the tag never pushes it offscreen.
    handleTrailingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
    },
    handleShrink: {
        flexShrink: 1,
        minWidth: 0,
    },
});

export default React.memo(UserName);
