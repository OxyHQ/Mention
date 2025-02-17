import React, { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import { View, FlatList, StyleSheet, ActivityIndicator, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import Post from '@/components/Post';
import { Header } from '@/components/Header';
import { useSelector, useDispatch } from 'react-redux';
import { fetchBookmarkedPosts } from '@/store/reducers/postsReducer';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { AppDispatch } from '@/store/store';

const BookmarksScreen = () => {
    const posts = useSelector((state: any) => state.posts.bookmarkedPosts);
    const loading = useSelector((state: any) => state.posts.loading);
    const dispatch = useDispatch<AppDispatch>();
    const session = useContext(SessionContext);
    const { t } = useTranslation();

    const currentUser = session?.getCurrentUser();

    // Memoize posts to prevent unnecessary re-renders
    const memoizedPosts = useMemo(() => posts, [posts]);

    const fetchBookmarkedPostsHandler = useCallback(async () => {
        if (currentUser) {
            await dispatch(fetchBookmarkedPosts());
        }
    }, [currentUser, dispatch]);

    useEffect(() => {
        if (!posts?.length) {
            fetchBookmarkedPostsHandler();
        }
    }, [fetchBookmarkedPostsHandler, posts?.length]);

    if (!session) {
        return (
            <View style={styles.container}>
                <Text>{t('Please log in to view bookmarks')}</Text>
            </View>
        );
    }

    const renderPost = useCallback(({ item }) => (
        <Post postData={item} />
    ), []);

    const keyExtractor = useCallback((item) => 
        item.id.toString()
    , []);

    return (
        <>
            <Header options={{ title: t('Bookmarks') }} />
            {loading && !posts?.length ? (
                <ActivityIndicator size="large" color="#1DA1F2" />
            ) : memoizedPosts && memoizedPosts.length > 0 ? (
                <FlatList
                    data={memoizedPosts}
                    renderItem={renderPost}
                    keyExtractor={keyExtractor}
                    maxToRenderPerBatch={10}
                    windowSize={5}
                    removeClippedSubviews={true}
                />
            ) : (
                <View style={styles.container}>
                    <Text>{t('No bookmarks found')}</Text>
                </View>
            )}
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        padding: 16,
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
});

export default BookmarksScreen;
