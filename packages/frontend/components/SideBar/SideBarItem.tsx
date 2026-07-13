import React, { useCallback } from 'react';
import { View, Text, Platform, Pressable, type ViewStyle, type TextStyle } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { UnreadBadge } from '@/components/notifications/UnreadBadge';
import { cn } from '@/lib/utils';

const WEB_BG_TRANSITION: ViewStyle | undefined = Platform.OS === 'web'
    ? ({
        transition: 'background-color 200ms cubic-bezier(0.2, 0, 0, 1)',
        cursor: 'pointer',
    } as ViewStyle)
    : undefined;

const WEB_COLOR_TRANSITION_VIEW: ViewStyle | undefined = Platform.OS === 'web'
    ? ({
        transition: 'color 200ms cubic-bezier(0.2, 0, 0, 1)',
    } as ViewStyle)
    : undefined;

const WEB_COLOR_TRANSITION_TEXT: TextStyle | undefined = Platform.OS === 'web'
    ? ({
        transition: 'color 200ms cubic-bezier(0.2, 0, 0, 1)',
    } as TextStyle)
    : undefined;

export const SideBarItem = React.memo(function SideBarItem({
    isActive,
    icon,
    text,
    href,
    isExpanded = false,
    onPress,
    badgeCount,
}: {
    isActive: boolean;
    icon: React.ReactNode;
    text: string;
    href?: Href;
    isExpanded?: boolean;
    onPress?: () => void;
    /** When set, overlays an unread pill/dot on the icon (e.g. notifications). */
    badgeCount?: number;
}) {
    const router = useRouter();
    const { t } = useTranslation();
    const { colors } = useTheme();
    const [isHovered, setIsHovered] = React.useState(false);

    const isHighlighted = isActive || isHovered;

    // react-native-svg resolves an icon's `currentColor` from its OWN `color`
    // prop, not from an ancestor's CSS `color` — React Native has no CSS cascade.
    // The wrapping <View>'s `text-*` class therefore colors these custom SVG
    // icons on web only. On native we resolve the same theme token the class maps
    // to (`primary` when active/hovered, else `foreground`/`text`) and inject it
    // straight onto the icon element so the active/hover/foreground states match.
    // The profile row's Avatar simply ignores the extra `color` prop.
    const themedIcon = Platform.OS === 'web'
        ? icon
        : React.isValidElement<{ color?: string }>(icon)
            ? React.cloneElement(icon, { color: isHighlighted ? colors.primary : colors.text })
            : icon;

    const handlePress = useCallback(() => {
        if (onPress) return onPress();
        // `href` is only ever a tab-root destination from the persistent SideBar.
        // Use `navigate` (not `push`) so re-selecting a tab pops to its existing
        // instance in the (app) Stack instead of stacking a duplicate. This is an
        // imperative Pressable (not an expo-router <Link>), so no middle-click /
        // SEO link affordance is affected by this change.
        if (href) router.navigate(href);
    }, [onPress, href, router]);

    const handleHoverIn = useCallback(() => setIsHovered(true), []);
    const handleHoverOut = useCallback(() => setIsHovered(false), []);

    return (
        <Pressable
            onPress={handlePress}
            onHoverIn={handleHoverIn}
            onHoverOut={handleHoverOut}
            className={cn(
                "flex-row items-center rounded-[35px] py-2.5 mb-1.5",
                isExpanded ? "w-full self-stretch px-4" : "self-center px-3",
                isActive && "bg-primary/10",
                isHovered && !isActive && "bg-primary/5",
            )}
            style={({ pressed }: { pressed: boolean }) => [
                pressed ? { backgroundColor: 'hsla(var(--primary), 0.13)' } : null,
                WEB_BG_TRANSITION,
            ]}
        >
            <View className={cn(
                "flex-row items-center w-full",
                isExpanded ? "justify-start gap-3" : "justify-center gap-0",
            )}>
                <View
                    className={cn(
                        "items-center justify-center w-6 h-6",
                        isHighlighted ? "text-primary" : "text-foreground",
                    )}
                    style={WEB_COLOR_TRANSITION_VIEW}
                >
                    {themedIcon}
                    {typeof badgeCount === 'number' ? (
                        <UnreadBadge
                            count={badgeCount}
                            dot={!isExpanded}
                            accessibilityLabel={t('notification.badge', { count: badgeCount, defaultValue: '{{count}} unread notifications' })}
                        />
                    ) : null}
                </View>
                {isExpanded && (
                    <Text
                        className={cn(
                            "text-[15px] whitespace-nowrap",
                            isActive ? "font-semibold" : "font-medium",
                            isHighlighted ? "text-primary" : "text-foreground",
                        )}
                        style={WEB_COLOR_TRANSITION_TEXT}
                    >
                        {text}
                    </Text>
                )}
            </View>
        </Pressable>
    );
});
