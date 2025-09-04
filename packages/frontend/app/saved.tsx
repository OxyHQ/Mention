import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import Feed from '../components/Feed/Feed';
import { colors } from '../styles/colors';

const SavedPostsScreen: React.FC = () => {
    const insets = useSafeAreaInsets();

    const handleSavePress = async (postId: string) => {
        // This is handled by the Feed component's PostItem internally
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <Stack.Screen
                options={{
                    title: 'Saved Posts',
                    headerShown: true,
                }}
            />

            <Feed type="posts" showOnlySaved={true} onSavePress={handleSavePress} />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
});

export default SavedPostsScreen;
