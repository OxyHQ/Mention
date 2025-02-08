import React, { useState, useEffect, useContext } from 'react';
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
    const dispatch = useDispatch<AppDispatch>();
    const session = useContext(SessionContext);
    const { t } = useTranslation();

    if (!session) {
        return (
            <View style={styles.container}>
                <Text>Session not available.</Text>
            </View>
        );
    }

    const { getCurrentUser } = session;
    const currentUser = getCurrentUser();
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (currentUser) {
            dispatch(fetchBookmarkedPosts());
        } else {
            setLoading(false);
        }
    }, [currentUser, dispatch]);

    useEffect(() => {
        setLoading(false);
    }, [posts]);

    return (
        <>
            <Header options={{ title: t('Bookmarks') }} />
            {loading ? (
                <ActivityIndicator size="large" color="#1DA1F2" />
            ) : posts && posts.length > 0 ? (
                <FlatList
                    data={posts}
                    renderItem={({ item }) => <Post postData={item} />}
                    keyExtractor={(item) => item.id.toString()}
                />
            ) : (
                <View style={styles.container}>
                    <Text>No bookmarks found.</Text>
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
