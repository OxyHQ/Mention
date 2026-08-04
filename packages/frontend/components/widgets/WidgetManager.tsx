import React, { Component, ReactNode, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { WhoToFollowWidget } from './WhoToFollowWidget';
import { TrendsWidget } from './TrendsWidget';
import { LiveRoomsWidget } from './LiveRoomsWidget';
import { createLogger } from '@oxyhq/core/logger';

const logger = createLogger('WidgetManager');

class WidgetErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
    state = { hasError: false };
    static getDerivedStateFromError() { return { hasError: true }; }
    componentDidCatch(error: Error) { logger.error('Widget crashed', error); }
    render() { return this.state.hasError ? null : this.props.children; }
}

function WidgetSlot({ children }: { children: ReactNode }) {
    return (
        <View style={styles.slot} collapsable={false}>
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
    const allWidgets = useMemo(() => [...screenWidgets, ...customWidgets], [screenWidgets, customWidgets]);

    if (allWidgets.length === 0) {
        return null;
    }

    // No `gap` here on purpose — every widget hides itself when it has nothing
    // to show, and a gap would still be charged for each hidden one, leaving a
    // column of blank space where the rail should have collapsed. Widgets carry
    // their own bottom spacing (see `BaseWidget`).
    return (
        <View className="flex-col">
            {allWidgets.map((widget, index) => {
                const slotKey = (widget as React.ReactElement)?.key?.toString() ?? `widget-${index}`;
                return (
                    <WidgetErrorBoundary key={slotKey}>
                        <WidgetSlot>
                            {widget}
                        </WidgetSlot>
                    </WidgetErrorBoundary>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    slot: {
        width: '100%',
    },
});
