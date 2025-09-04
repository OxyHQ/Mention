import React, { ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
    BaseWidget
} from './';

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
                    <View key="trending-topics">
                        <Text>Trending Topics Widget</Text>
                    </View>,
                    <View key="suggested-users">
                        <Text>Suggested Users Widget</Text>
                    </View>,
                    <View key="activity-feed">
                        <Text>Activity Feed Widget</Text>
                    </View>
                ];

            case 'explore':
                return [
                    <View key="popular-posts">
                        <Text>Popular Posts Widget</Text>
                    </View>,
                    <View key="trending-topics">
                        <Text>Trending Topics Widget</Text>
                    </View>
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
                    <View key="trending-topics">
                        <Text>Trending Topics Widget</Text>
                    </View>
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
        padding: 10,
    },
    widgetWrapper: {
        marginBottom: 16,
    },
});
}

const styles = StyleSheet.create({
    container: {
        padding: 10,
    },
    widgetWrapper: {
        marginBottom: 16,
    },
});

const screenWidgets = getWidgetsForScreen(screenId);

// Combine screen-specific widgets with any custom widgets passed as props
const allWidgets = [...screenWidgets, ...customWidgets];

if (allWidgets.length === 0) {
    return null;
}

return (
    <View style={styles.container}>
        {allWidgets.map((widget, index) => (
            <View key={`widget-${index}`} style={styles.widgetWrapper}>
                {widget}
            </View>
        ))}
    </View>
);
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'column',
        gap: 10,
    },
    widgetWrapper: {
        marginBottom: 10,
    }
}); 