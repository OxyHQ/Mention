import React, { useState, useEffect } from 'react';
import { SafeAreaView, StyleSheet, View, TouchableOpacity, Text } from 'react-native';
import Feed from '../components/Feed';
import { PostProvider } from '../context/PostContext';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { FeedType } from '@/hooks/useFeed';
import { useOxy } from '@oxyhq/services';
import { router } from 'expo-router';

const HomeScreen: React.FC = () => {
    const [feedType, setFeedType] = useState<FeedType>('all');
    const { t } = useTranslation();
    const { isAuthenticated } = useOxy();

    useEffect(() => {
        // Set default feed type based on authentication
        if (isAuthenticated) {
            setFeedType('home');
        } else {
            setFeedType('all');
        }
    }, [isAuthenticated]);

    const handleCreatePostPress = () => {
        router.push('/compose');
    };

    return (
        <PostProvider>
            <SafeAreaView style={styles.container}>
                <View style={styles.feedToggle}>
                    <TouchableOpacity 
                        style={[styles.toggleButton, (feedType === 'all' || feedType === 'home') && styles.activeToggle]} 
                        onPress={() => setFeedType(isAuthenticated ? 'home' : 'all')}
                    >
                        <Text style={[styles.toggleText, (feedType === 'all' || feedType === 'home') && styles.activeToggleText]}>
                            {t('For You')}
                        </Text>
                    </TouchableOpacity>
                    <TouchableOpacity 
                        style={[styles.toggleButton, feedType === 'following' && styles.activeToggle]} 
                        onPress={() => setFeedType('following')}
                    >
                        <Text style={[styles.toggleText, feedType === 'following' && styles.activeToggleText]}>
                            {t('Following')}
                        </Text>
                    </TouchableOpacity>
                </View>
                <Feed 
                    showCreatePost 
                    type={feedType} 
                    onCreatePostPress={handleCreatePostPress}
                />
            </SafeAreaView>
        </PostProvider>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    feedToggle: {
        flexDirection: 'row',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    toggleButton: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 15,
    },
    activeToggle: {
        borderBottomWidth: 2,
        borderBottomColor: colors.primaryColor,
    },
    toggleText: {
        fontSize: 16,
        fontWeight: '500',
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    activeToggleText: {
        fontWeight: 'bold',
        color: colors.primaryColor,
    },
});

export default HomeScreen;