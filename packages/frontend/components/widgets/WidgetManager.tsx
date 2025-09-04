import React, { ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
    BaseWidget
} from './';
import { WhoToFollowWidget } from './WhoToFollowWidget';
import { FollowingWidget } from './FollowingWidget';
import { TrendsWidget } from './TrendsWidget';

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
    // Define which widgets should appear on which screens
    const getWidgetsForScreen = (screen: ScreenId): ReactNode[] => {
        switch (screen) {
            case 'home':
                return [
                    <TrendsWidget key="trends" />,
                    <WhoToFollowWidget key="who-to-follow" />,
                    <FollowingWidget key="following-preview" />,
                ];

            case 'explore':
                return [
                    <TrendsWidget key="trends" />,
                ];

            case 'notifications':
                return [
                    <View key="notifications">
                        <Text>Notifications Widget</Text>
                    </View>
                ];

            case 'messages':
                return [
                    <View key="messages-preview">
                        <Text>Messages Preview Widget</Text>
                    </View>
                ];

            case 'saved':
                return [
                    <View key="saved">
                        <Text>Saved Posts Widget</Text>
                    </View>
                ];

            case 'profile':
                return [
                    <View key="profile-stats">
                        <Text>Profile Stats Widget</Text>
                    </View>,
                    <View key="engagement-stats">
                        <Text>Engagement Stats Widget</Text>
                    </View>
                ];

            case 'post-detail':
                return [
                    <View key="related-posts">
                        <Text>Related Posts Widget</Text>
                    </View>,
                    <View key="recently-viewed">
                        <Text>Recently Viewed Widget</Text>
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
        <View style={styles.container}>
            {allWidgets.map((widget, index) => (
                <View key={index} style={styles.widgetWrapper}>
                    {widget}
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'column',
        gap: 15,
    },
    widgetWrapper: {
        marginBottom: 0, // No margin since we're using gap
    },
});
