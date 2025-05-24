import React from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import Feed from '../components/Feed';
import { PostProvider } from '../context/PostContext';

const HomeScreen: React.FC = () => {
    return (
        <PostProvider>
            <SafeAreaView style={styles.container}>
                <Feed showCreatePost />
            </SafeAreaView>
        </PostProvider>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
});

export default HomeScreen;