import React, { Component, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { WhoToFollowWidget } from './WhoToFollowWidget';
import { TrendsWidget } from './TrendsWidget';
import { LiveRoomsWidget } from './LiveRoomsWidget';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('WidgetManager');

class WidgetErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
    state = { hasError: false };
    static getDerivedStateFromError() { return { hasError: true }; }
    componentDidCatch(error: Error) { logger.error('Widget crashed', { error }); }
    render() { return this.state.hasError ? null : this.props.children; }
}

function WidgetSlot({
    slotId,
    children,
    onVisibilityChange,
}: {
    slotId: string;
    children: ReactNode;
    onVisibilityChange: (slotId: string, visible: boolean) => void;
}) {
    const ref = React.useRef<View>(null);

    useEffect(() => {
        const node = ref.current;
        const hasVisibleContent = Boolean(node && node.children && node.children.length > 0);
        onVisibilityChange(slotId, hasVisibleContent);
    }, [children, onVisibilityChange, slotId]);

    return (
        <View ref={ref} style={styles.slot} collapsable={false}>
            {children}
        </View>
    );
}

// Define screen IDs for social network
export type ScreenId =
    | 'home'
    | 'explore'
    | 'notifications'
    | 'messages'
    | 'saved'
    | 'profile'
    | 'post-detail'
    | 'search';

interface WidgetManagerProps {
    screenId: ScreenId;
    customWidgets?: ReactNode[];
}

/**
 * Widget Manager Component
 * 
 * This component controls which widgets should appear on which screens.
 * It provides a centralized way to manage widget visibility based on screen context.
 */
export function WidgetManager({ screenId, customWidgets = [] }: WidgetManagerProps) {
    const { t } = useTranslation();
    const [visibleSlots, setVisibleSlots] = useState<Record<string, boolean>>({});

    const handleVisibilityChange = useCallback((slotId: string, visible: boolean) => {
        setVisibleSlots((previous) => {
            if (previous[slotId] === visible) return previous;
            return { ...previous, [slotId]: visible };
        });
    }, []);

    // Define which widgets should appear on which screens
    const getWidgetsForScreen = (screen: ScreenId): ReactNode[] => {
        switch (screen) {
            case 'home':
                return [
                    <LiveRoomsWidget key="live-rooms" divider />,
                    <TrendsWidget key="trends" divider />,
                    <WhoToFollowWidget key="who-to-follow" />,
                ];

            case 'explore':
                return [
                    <TrendsWidget key="trends" />,
                ];

            case 'notifications':
                return [
                    <View key="notifications">
                        <Text>{t('widgets.notifications')}</Text>
                    </View>
                ];

            case 'messages':
                return [
                    <View key="messages-preview">
                        <Text>{t('widgets.messagesPreview')}</Text>
                    </View>
                ];

            case 'saved':
                return [
                    <View key="saved">
                        <Text>{t('widgets.savedPosts')}</Text>
                    </View>
                ];

            case 'profile':
                return [
                    <View key="profile-stats">
                        <Text>{t('widgets.profileStats')}</Text>
                    </View>,
                    <View key="engagement-stats">
                        <Text>{t('widgets.engagementStats')}</Text>
                    </View>
                ];

            case 'post-detail':
                return [
                    <View key="related-posts">
                        <Text>{t('widgets.relatedPosts')}</Text>
                    </View>,
                    <View key="recently-viewed">
                        <Text>{t('widgets.recentlyViewed')}</Text>
                    </View>
                ];

            case 'search':
                return [
                    <TrendsWidget key="trends" />,
                ];

            default:
                return [];
        }
    };

    const screenWidgets = getWidgetsForScreen(screenId);

    // Combine screen-specific widgets with any custom widgets passed as props
    const allWidgets = useMemo(() => [...screenWidgets, ...customWidgets], [screenWidgets, customWidgets]);

    const widgetSlots = useMemo(() => allWidgets.map((widget, index) => {
        const slotKey = (widget as React.ReactElement)?.key?.toString() ?? `widget-${index}`;
        return { slotKey, widget };
    }), [allWidgets]);

    useEffect(() => {
        setVisibleSlots({});
    }, [screenId, customWidgets]);

    const hasVisibleWidgets = useMemo(() => Object.values(visibleSlots).some(Boolean), [visibleSlots]);

    if (allWidgets.length === 0 || !hasVisibleWidgets) {
        return null;
    }

    return (
        <View className="flex-col gap-4">
            {widgetSlots.map(({ slotKey, widget }) => (
                <WidgetErrorBoundary key={slotKey}>
                    <WidgetSlot slotId={slotKey} onVisibilityChange={handleVisibilityChange}>
                        {widget}
                    </WidgetSlot>
                </WidgetErrorBoundary>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    slot: {
        width: '100%',
    },
});
