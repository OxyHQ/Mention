import React, { Component, ReactNode } from 'react';
import { View, Text } from 'react-native';
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
    // Define which widgets should appear on which screens
    const getWidgetsForScreen = (screen: ScreenId): ReactNode[] => {
        switch (screen) {
            case 'home':
                return [
                    <LiveRoomsWidget key="live-rooms" />,
                    <TrendsWidget key="trends" />,
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
    const allWidgets = [...screenWidgets, ...customWidgets];

    if (allWidgets.length === 0) {
        return null;
    }

    return (
        <View className="flex-col gap-4">
            {allWidgets.map((widget) => (
                <WidgetErrorBoundary key={(widget as React.ReactElement)?.key ?? undefined}>
                    {widget}
                </WidgetErrorBoundary>
            ))}
        </View>
    );
}
